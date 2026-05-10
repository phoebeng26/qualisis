'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createPortal } from 'react-dom'
import AIComparePanel from './AIComparePanel'
import HumanCodePanel from './HumanCodePanel'
import HumanHighlightTooltip from './HumanHighlightTooltip'
import MassReviewModal from './MassReviewModal'
import { DEFAULT_PROMPT } from '@/lib/ai'
import { buildSystematicPrompt } from '@/lib/prompts'
import ConfirmModal from './ConfirmModal'

type Suggestion = {
    id: string
    label: string
    explanation: string
    confidence: string
    alternatives: string[]
    uncertainty: string | null
    modelProvider: string | null
    status: string
    reviewDecision: { action: string; note: string | null } | null
}

type Segment = {
    id: string
    text: string
    startIndex: number
    endIndex: number
    speaker: string | null
    order: number
    suggestions: Suggestion[]
    codeAssignments: { 
        codebookEntry: { name: string }
        aiSuggestionId?: string | null 
    }[]
}

type Transcript = {
    id: string
    title: string
    content: string
    status: string
    segments: Segment[]
    dataset: { name: string }
    metadata?: any
}

type Stats = { totalHighlights: number; assignedCodes: number; pendingReview: number }

type ActivePanel =
    | { type: 'ai'; segment: Segment }
    | { type: 'human'; text: string; codeName: string; spanEl?: HTMLSpanElement; segmentId: string }
    | null

export default function TranscriptWorkspace({
    transcript,
    projectId,
    stats: initialStats,
}: {
    transcript: Transcript
    projectId: string
    stats: Stats
}) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [segments, setSegments] = useState<Segment[]>(transcript.segments)
    const [stats, setStats] = useState(initialStats)
    const [analysisRun, setAnalysisRun] = useState(transcript.segments.length > 0)

    // Sync state when transcript data is refreshed from the server (e.g. after router.refresh())
    useEffect(() => {
        setSegments(transcript.segments)
        setStats(initialStats)
        if (transcript.segments.length > 0) {
            setAnalysisRun(true)
        }
    }, [transcript.segments, initialStats])
    const [activePanel, setActivePanel] = useState<ActivePanel>(null)
    const [isAnalyzing, setIsAnalyzing] = useState(false)
    const abortControllerRef = useRef<AbortController | null>(null)
    const [selectedModels, setSelectedModels] = useState<Record<string, boolean>>({ gpt: true, claude: true, gemini: true })
    const [showModelPicker, setShowModelPicker] = useState(false)
    const [analyzingStep, setAnalyzingStep] = useState(0)
    const [mounted, setMounted] = useState(false)
    const [showMassReview, setShowMassReview] = useState<'ALL' | 'PENDING' | 'ACCEPTED' | null>(null)
    const [isFetchingForReview, setIsFetchingForReview] = useState(false)
    const [showEditConfirm, setShowEditConfirm] = useState(false)
    const [isRightBarCollapsed, setIsRightBarCollapsed] = useState(false)

    const refreshSegments = useCallback(async () => {
        try {
            const res = await fetch(`/api/transcripts/${transcript.id}`)
            if (res.ok) {
                const data = await res.json()
                setSegments(data.segments || [])
                if ((data.segments || []).length > 0) setAnalysisRun(true)
            }
        } catch (e) {
            console.error('Failed to refresh segments:', e)
        }
    }, [transcript.id])

    const [toastMessage, setToastMessage] = useState<{ message: string; visible: boolean } | null>(null)
    const [showObsPanel, setShowObsPanel] = useState(false)
    const [obsForm, setObsForm] = useState({ label: '', note: '', context: '' })
    const [obsSaving, setObsSaving] = useState(false)
    const [showHighlightGuide, setShowHighlightGuide] = useState(false)
    const transcriptBodyRef = useRef<HTMLDivElement>(null)

    const triggerToast = useCallback((message: string) => {
        setToastMessage({ message, visible: true })
        setTimeout(() => {
            setToastMessage(prev => prev ? { ...prev, visible: false } : null)
            setTimeout(() => setToastMessage(null), 300) // remove from DOM after fade out
        }, 4000)
    }, [])



    const createObservationCode = async () => {
        if (!obsForm.label.trim()) return
        setObsSaving(true)
        try {
            await fetch('/api/codebook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId,
                    name: obsForm.label.trim(),
                    definition: obsForm.note.trim() || null,
                    memo: obsForm.context.trim() || null,
                    type: 'OBSERVATION',
                    examplesIn: JSON.stringify([{ id: transcript.id, name: transcript.title }]),
                    examplesOut: '',
                })
            })
            setObsForm({ label: '', note: '', context: '' })
            setShowObsPanel(false)
            triggerToast('Memo saved to Unassigned Codes!')
        } catch {}
        setObsSaving(false)
    }

    const handleDecision = useCallback(async (segId: string, action: string, label?: string, note?: string, specificSuggestionId?: string) => {
        // Find the segment to get its suggestions
        const seg = segments.find(s => s.id === segId)
        if (!seg) return

        // Map action names to API action names
        const apiAction = action === 'ACCEPT' ? 'ACCEPT' : action === 'REJECT' ? 'REJECT' : action === 'RESTORE' ? 'RESTORE' : 'OVERRIDE'

        // If a specific suggestion is targeted (e.g. from mass review), only call API for that one.
        // Otherwise (AIComparePanel), mirror action across all non-rejected suggestions in the segment.
        const suggestionsToReview = specificSuggestionId
            ? seg.suggestions.filter(sg => sg.id === specificSuggestionId)
            : seg.suggestions.filter(sg => sg.status !== 'REJECTED' || action === 'RESTORE')

        if (suggestionsToReview.length === 0) return

        await Promise.allSettled(
            suggestionsToReview.map(sg =>
                fetch(`/api/segments/${segId}/review`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: apiAction, customLabel: label, suggestionId: sg.id, note }),
                })
            )
        )

        // Update local state after API calls succeed
        setSegments(prev => prev.map(s =>
            s.id === segId
                ? {
                    ...s,
                    suggestions: s.suggestions.map(sg => {
                        // Only update the targeted suggestion(s)
                        if (specificSuggestionId && sg.id !== specificSuggestionId) return sg
                        return {
                            ...sg,
                            status: action === 'ACCEPT' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : action === 'RESTORE' ? 'SUGGESTED' : 'MODIFIED'
                        }
                    })
                }
                : s
        ))
        setStats(prev => ({
            ...prev,
            assignedCodes: action === 'RESTORE' ? Math.max(0, prev.assignedCodes - 1) : (action !== 'REJECT' ? prev.assignedCodes + 1 : prev.assignedCodes),
            pendingReview: action === 'RESTORE' ? prev.pendingReview + 1 : Math.max(0, prev.pendingReview - 1),
        }))
    }, [segments]);

    // Track time spent reading the transcript
    useEffect(() => {
        const startTime = Date.now();
        return () => {
            const timeSpentSecs = Math.floor((Date.now() - startTime) / 1000);
            if (timeSpentSecs >= 3 && typeof window !== 'undefined') {
                const data = new Blob([JSON.stringify({ durationSeconds: timeSpentSecs })], { type: 'application/json' });
                navigator.sendBeacon(`/api/transcripts/${transcript.id}/log-view`, data);
            }
        };
    }, [transcript.id]);

    const [isEditingText, setIsEditingText] = useState(false)
    const [editedContent, setEditedContent] = useState(transcript.content)
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        setEditedContent(transcript.content)
    }, [transcript.content])

    const saveEditedContent = async () => {
        setIsSaving(true);
        try {
            const res = await fetch(`/api/transcripts/${transcript.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editedContent }),
            })
            if (!res.ok) throw new Error('Failed to save transcript');
            setIsEditingText(false);
            router.refresh(); // Tells NextJS to refresh server data, triggering useEffect above
        } catch (e: any) {
            alert(e.message)
        } finally {
            setIsSaving(false);
        }
    }

    const exportTranscriptCoded = () => {
        const rows = segments.map(seg => {
            const acceptedSuggestions = seg.suggestions.filter(s => s.status === 'APPROVED' || s.status === 'MODIFIED').map(s => s.label);
            const humanCodes = seg.codeAssignments?.map(c => c.codebookEntry.name) || [];
            const allCodes = Array.from(new Set([...acceptedSuggestions, ...humanCodes]));
            
            if (allCodes.length === 0) return '';
            
            return `<tr>
                <td style="padding: 10px; border: 1px solid #e5e7eb; vertical-align: top;">${seg.text}</td>
                <td style="padding: 10px; border: 1px solid #e5e7eb; vertical-align: top; font-weight: bold; color: #4f46e5;">
                    ${allCodes.join('<br/><br/>')}
                </td>
            </tr>`;
        }).filter(Boolean).join('');

        const html = `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>${transcript.title}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 2cm; }
  h2 { color: #3730a3; border-bottom: 2px solid #e0e7ff; padding-bottom: 5px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 30px; }
  th { background: #e0e7ff; color: #3730a3; padding: 10px; border: 1px solid #c7d2fe; text-align: left; }
</style>
</head><body>
<h2>Coded Highlights: ${transcript.title}</h2>
<table>
  <thead><tr><th style="width: 70%">Participant Extract</th><th style="width: 30%">Applied Codes</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="2" style="padding: 10px; text-align: center;">No codes applied yet.</td></tr>'}</tbody>
</table>
<br/><br/>
<h2>Full Raw Transcript</h2>
<pre style="white-space: pre-wrap; font-family: Calibri, Arial, sans-serif; text-align: justify;">${transcript.content}</pre>
</body></html>`;

        const blob = new Blob([html], { type: 'application/msword' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${transcript.title.replace(/\s+/g, '_')}_Coded.doc`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    useEffect(() => {
        setMounted(true)
    }, [])

    // ── Deep-link: scroll to segment from ?segment= query param or quote ─────
    useEffect(() => {
        const targetSegId = searchParams?.get('segment')
        const targetQuote = searchParams?.get('quote')
        if ((!targetSegId && !targetQuote) || !mounted) return

        // Retry a few times because the segment elements render async
        let attempts = 0
        const tryScroll = () => {
            if (targetQuote) {
                const cleanQuote = targetQuote.replace(/^["']|["']$/g, '').trim()
                if (cleanQuote) {
                    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
                    const normQuote = normalize(cleanQuote)
                    
                    if (normQuote.length > 5) {
                        const elements = Array.from(document.querySelectorAll('[data-segment-id]')) as HTMLElement[]
                        let bestMatch = null
                        let bestScore = 0
                        
                        for (const el of elements) {
                            const normEl = normalize(el.textContent || '')
                            if (!normEl) continue
                            
                            if (normEl.includes(normQuote) || normQuote.includes(normEl)) {
                                const score = Math.min(normEl.length, normQuote.length)
                                if (score > bestScore && score > 5) {
                                    bestScore = score
                                    bestMatch = el
                                }
                            }
                        }
                        
                        if (bestMatch) {
                            bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' })
                            bestMatch.style.transition = 'box-shadow 0.2s ease, outline 0.2s ease'
                            bestMatch.style.outline = '2.5px solid #f59e0b'
                            bestMatch.style.outlineOffset = '3px'
                            bestMatch.style.borderRadius = '4px'
                            setTimeout(() => {
                                bestMatch.style.outline = ''
                                bestMatch.style.outlineOffset = ''
                            }, 2000)
                            window.getSelection()?.removeAllRanges()
                            return
                        }
                    }

                    // Fallback to native text search
                    window.getSelection()?.removeAllRanges()
                    const found = (window as any).find(cleanQuote, false, false, true, false, false, false)
                    if (found) return
                }
            }

            if (targetSegId) {
                const el = document.querySelector(`[data-segment-id="${targetSegId}"]`) as HTMLElement | null
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    // Flash animation: golden ring that fades out
                    el.style.transition = 'box-shadow 0.2s ease, outline 0.2s ease'
                    el.style.outline = '2.5px solid #f59e0b'
                    el.style.outlineOffset = '3px'
                    el.style.borderRadius = '4px'
                    setTimeout(() => {
                        el.style.outline = ''
                        el.style.outlineOffset = ''
                    }, 2000)
                    return
                }
            }
            
            if (attempts < 10) {
                attempts++
                setTimeout(tryScroll, 300)
            }
        }
        // Small delay to let React finish rendering the transcript
        const t = setTimeout(tryScroll, 400)
        return () => clearTimeout(t)
    }, [mounted, searchParams])

    useEffect(() => {
        if (!isAnalyzing) {
            setAnalyzingStep(0)
            return
        }
        const t1 = setTimeout(() => setAnalyzingStep(1), 15000)
        const t2 = setTimeout(() => setAnalyzingStep(2), 60000)
        const t3 = setTimeout(() => setAnalyzingStep(3), 150000)
        // Step 4 is set explicitly upon network completion!
        return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); }
    }, [isAnalyzing])

    const [researchContext, setResearchContext] = useState('')
    const [showFullPrompt, setShowFullPrompt] = useState(false)
    const [styleMode, setStyleMode] = useState<'explore' | 'style-copy'>('explore')

    // Build the full prompt preview so user can see what is actually sent
    const fullPromptPreview = buildSystematicPrompt(
        researchContext,
        transcript.metadata || {},
        '(Summary will be auto-generated before analysis)'
    )

    // Click handler for human highlighted text
    const handleTranscriptClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('h-human')) {
            const title = target.getAttribute('title') || '';
            const codeName = title.replace('Human Code: ', '');
            const segmentId = target.getAttribute('data-segment-id') || '';
            setActivePanel({ type: 'human', text: target.innerText, codeName, segmentId });
        }
    };

    // Run AI analysis
    const runAnalysis = useCallback(async () => {
        setIsAnalyzing(true)
        setShowModelPicker(false)
        setActivePanel(null)
        setAnalyzingStep(0)
        
        const abortController = new AbortController()
        abortControllerRef.current = abortController

        const models = Object.entries(selectedModels)
            .filter(([, v]) => v)
            .map(([k]) => k)

        try {
            const startTime = Date.now()
            
            const res = await fetch(`/api/transcripts/${transcript.id}/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ models, researchContext, styleMode }),
                signal: abortController.signal
            })
            
            if (!res.ok) {
                const data = await res.json().catch(() => ({ error: 'Unknown server error' }))
                throw new Error(data.error || 'Failed to start analysis')
            }

            // No artificial delay — proceed immediately to the final completion step.
            
            // Mark the 4th step as complete when ALL is actually done!
            setAnalyzingStep(4)
            await new Promise(resolve => setTimeout(resolve, 800)) // Pause for 0.8s to let user see "Synthesizing Consensus" finished

            // Force close modal BEFORE starting the background Next.js refresh transition
            setIsAnalyzing(false)
            
            // Defers router.refresh to next tick so it doesn't batch/freeze the modal state
            setTimeout(() => {
                router.refresh()
                setAnalysisRun(true)
            }, 0)
        } catch (e: any) {
            if (e.name === 'AbortError') {
                console.log('Analysis cancelled');
                setIsAnalyzing(false);
                return;
            }
            console.error(e)
            alert('Analysis failed: ' + (e.message || String(e)))
            setIsAnalyzing(false)
        }
    }, [transcript.id, selectedModels, researchContext, router, styleMode])

    // Group suggestions by modelProvider for display
    const getModelSuggestions = (seg: Segment) => {
        const byModel: Record<string, Suggestion> = {}
        for (const s of seg.suggestions) {
            if (s.modelProvider) byModel[s.modelProvider] = s
        }
        return byModel
    }

    type DisplaySegment = 
        | { type: 'highlight', id: string, startIndex: number, endIndex: number, seg: Segment }
        | { type: 'speaker', id: string, startIndex: number, endIndex: number, label: string, rawSpeaker: string, timestamp?: string }

    const displaySegments = useMemo(() => {
        const content = transcript.content;
        const dsArr: DisplaySegment[] = [];
        
        const speakerRegex = /^([A-Za-z_][A-Za-z0-9_ -]*)\s*:|^((?:\[?\d{1,2}:)?\d{2}:\d{2}\]?)\s+([A-Za-z_][A-Za-z0-9_ -]+)\s*$/gm;
        let match;
        while ((match = speakerRegex.exec(content)) !== null) {
            let rawTag = '';
            let timestamp = '';
            if (match[1]) {
                rawTag = match[1].trim();
            } else if (match[3]) {
                timestamp = match[2].trim();
                rawTag = match[3].trim();
            }
            if (!rawTag) continue;

            let label = rawTag.toUpperCase();
            if (transcript.metadata) {
                const { interviewer, participants } = transcript.metadata;
                if (interviewer && interviewer['Speaker Tag']?.toLowerCase() === rawTag.toLowerCase()) {
                    label = 'INTERVIEWER';
                } else if (participants) {
                    const p = participants.find((p: any) => p['Speaker Tag']?.toLowerCase() === rawTag.toLowerCase());
                    if (p) label = `PARTICIPANT (${rawTag})`;
                }
            }
            if (timestamp) label = `${label} • ${timestamp}`;

            dsArr.push({
                type: 'speaker',
                id: `spk-${match.index}`,
                startIndex: match.index,
                endIndex: match.index + match[0].length,
                label,
                rawSpeaker: rawTag,
                timestamp: timestamp || undefined
            });
        }

        if (analysisRun && segments.length > 0) {
            for (const seg of segments) {
                dsArr.push({
                    type: 'highlight',
                    id: seg.id,
                    startIndex: seg.startIndex,
                    endIndex: seg.endIndex,
                    seg
                });
            }
        }
        dsArr.sort((a, b) => a.startIndex - b.startIndex);
        return dsArr;
    }, [transcript.content, transcript.metadata, analysisRun, segments]);

    // Strip embedded speaker/timestamp lines from inside a text slice so they don't
    // appear inside highlighted segments when a segment straddles a speaker tag.
    const stripSpeakerTags = (text: string) =>
        text
            .replace(/^([A-Za-z_][A-Za-z0-9_ -]*)\s*:\s*/gm, '')        // "Speaker 1: "
            .replace(/^((?:\[?\d{1,2}:)?\d{2}:\d{2}\]?)\s+[A-Za-z_][A-Za-z0-9_ -]*\s*$/gm, '')  // "00:16:43 Speaker 1"
            .replace(/\n{2,}/g, ' ')  // collapse leftover blank lines into a space

    const renderTranscript = () => {
        const content = transcript.content;

        const blocks: { isSpeaker: boolean; label: string; rawSpeaker?: string; endTime?: string; nodes: React.ReactNode[] }[] = [];
        let currentBlock: { isSpeaker: boolean; label: string; rawSpeaker?: string; endTime?: string; nodes: React.ReactNode[] } = { isSpeaker: false, label: '', rawSpeaker: '', nodes: [] };
        const pushNode = (node: React.ReactNode) => currentBlock.nodes.push(node);
        
        let cursor = 0;

        for (const ds of displaySegments) {
            let actualStart = Math.max(ds.startIndex, cursor);

            // Skip entirely overlapped segments
            if (actualStart >= ds.endIndex && ds.endIndex > ds.startIndex) {
                // If it's a speaker tag but purely overlapped, still render the tag itself, just no new text prepended.
                if (ds.type !== 'speaker') continue;
            }

            if (actualStart > cursor) {
                let chunk = content.slice(cursor, actualStart);
                pushNode(
                    <span key={`pre-${ds.id}`} data-offset={cursor}>
                        {chunk}
                    </span>
                );
            }

            if (ds.type === 'speaker') {
                if (currentBlock.isSpeaker && currentBlock.rawSpeaker === ds.rawSpeaker) {
                    // Same speaker continues. Update the end time.
                    if (ds.timestamp) {
                        currentBlock.endTime = ds.timestamp;
                    }
                    // Text will automatically flow as a continuous paragraph since we are omitting the block spacer
                } else {
                    if (currentBlock.nodes.length > 0 || currentBlock.isSpeaker) {
                        blocks.push(currentBlock);
                    }
                    currentBlock = { isSpeaker: true, label: ds.label, rawSpeaker: ds.rawSpeaker, nodes: [] };
                }
                cursor = Math.max(cursor, ds.endIndex);
            } else if (ds.type === 'highlight') {
                const seg = ds.seg!;
                const validSuggestions = (seg.suggestions || []).filter(s => s.status !== 'REJECTED');
                const humanAssignments = seg.codeAssignments?.filter(c => !c.aiSuggestionId) || [];
                const isHuman = humanAssignments.length > 0;
                
                if (validSuggestions.length === 0 && !isHuman) continue;

                let accepted = false;
                let overridden = false;
                let label = '';
                let modelProviders: string[] = [];
                const activeColors: string[] = [];
                const activeBgRgb: string[] = [];

                if (isHuman) {
                    label = humanAssignments[0].codebookEntry.name;
                    modelProviders.push('Human');
                    activeColors.push('#a855f7');
                    activeBgRgb.push('168, 85, 247');
                } else {
                    accepted = validSuggestions.some(s => s.status === 'APPROVED');
                    overridden = validSuggestions.some(s => s.status === 'MODIFIED');
                    label = validSuggestions.find(s => s.status === 'APPROVED' || s.status === 'MODIFIED')?.label 
                               ?? validSuggestions[0]?.label ?? 'AI Code';

                    modelProviders.push(...Array.from(new Set(validSuggestions.map(s => s.modelProvider).filter(Boolean))) as string[]);
                    const hasGPT = modelProviders.some(m => m?.includes('GPT') || m?.includes('gpt'));
                    const hasGemini = modelProviders.some(m => m?.includes('Gemini') || m?.includes('gemini'));
                    const hasClaude = modelProviders.some(m => m?.includes('Claude') || m?.includes('claude'));

                    if (hasGPT) {
                        activeColors.push('#f59e0b'); // Yellow/Amber for GPT
                        activeBgRgb.push('251, 191, 36');
                    }
                    if (hasGemini) {
                        activeColors.push('#10b981'); // Green for Gemini
                        activeBgRgb.push('52, 211, 153');
                    }
                    if (hasClaude) {
                        activeColors.push('#0ea5e9'); // Blue for Claude
                        activeBgRgb.push('56, 189, 248');
                    }
                }

                let inlineStyle: React.CSSProperties = {};
                let underlineColor = '';

                if (isHuman) {
                    inlineStyle.backgroundColor = 'rgba(168, 85, 247, 0.2)';
                    underlineColor = '#a855f7';
                } else if (accepted) {
                    inlineStyle.backgroundColor = 'rgba(99, 102, 241, 0.2)'; // Indigo
                    activeColors.length = 0; activeColors.push('#6366f1');
                    underlineColor = '#6366f1';
                } else if (overridden) {
                    inlineStyle.backgroundColor = 'rgba(167, 139, 250, 0.2)';
                    activeColors.length = 0; activeColors.push('#a855f7');
                    underlineColor = '#a855f7';
                } else {
                    if (activeColors.length === 1) {
                        inlineStyle.backgroundColor = `rgba(${activeBgRgb[0]}, 0.15)`;
                        underlineColor = activeColors[0];
                    } else if (activeColors.length > 1) {
                        // Striped background for multiple models
                        const gradientParts = activeBgRgb.map((rgb, i) => {
                            const start = i * 8;
                            const end = (i + 1) * 8;
                            return `rgba(${rgb}, 0.15) ${start}px, rgba(${rgb}, 0.15) ${end}px`;
                        });
                        inlineStyle.backgroundImage = `repeating-linear-gradient(-45deg, ${gradientParts.join(', ')})`;
                        
                        // All models agree = Purple underline
                        const numSelectedModels = Object.values(selectedModels).filter(Boolean).length || activeColors.length;
                        if (activeColors.length === numSelectedModels && numSelectedModels > 1) {
                            underlineColor = '#a855f7'; // Purple
                        } else {
                            underlineColor = '#94a3b8'; // Slate
                        }
                    } else {
                        inlineStyle.backgroundColor = 'transparent';
                    }
                }

                let cls = isHuman 
                    ? 'h-human relative group cursor-pointer transition-colors rounded-sm px-0.5 '
                    : 'h-ai relative group cursor-pointer transition-colors rounded-sm px-0.5 ';

                if (underlineColor) {
                    inlineStyle.boxShadow = `0 2px 0 0 ${underlineColor}`;
                    inlineStyle.paddingBottom = '2px';
                }

                // Safe text extraction — strip embedded speaker tags that may fall within a segment range
                const textEnd = Math.max(actualStart, ds.endIndex);
                const textToRender = stripSpeakerTags(content.slice(actualStart, textEnd));
                
                if (textToRender.length > 0) {
                    pushNode(
                        <span
                            key={`${seg.id}-${actualStart}`}
                            className={cls}
                            style={inlineStyle}
                            data-segment-id={seg.id}
                            data-offset={actualStart}
                            title={isHuman ? `Human Code: ${label} (Click to edit)` : `${accepted ? 'AI Accepted' : 'AI Pending'}: ${label} (Click to review)`}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (isHuman) {
                                    setActivePanel({ type: 'human', text: textToRender, codeName: label, segmentId: seg.id });
                                } else {
                                    setActivePanel({ type: 'ai', segment: seg });
                                }
                            }}
                        >
                            {(accepted || isHuman) && actualStart === ds.startIndex && (
                                <span className={`inline-flex items-center justify-center text-white rounded-full w-[13px] h-[13px] mr-1.5 align-middle shadow-sm ${isHuman ? 'bg-purple-500' : 'bg-indigo-500'}`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                </span>
                            )}
                            <span className="whitespace-pre-wrap">{textToRender}</span>
                        </span>
                    );
                }
                cursor = textEnd;
            }
        }

        if (cursor < content.length) {
            let finalChunk = content.slice(cursor);
            pushNode(
                <span key="post-final" data-offset={cursor}>
                    {finalChunk}
                </span>
            );
        }

        if (currentBlock.nodes.length > 0 || currentBlock.isSpeaker) {
            blocks.push(currentBlock);
        }

        const palette = [
            { bar: 'bg-indigo-500/90', bg: 'bg-indigo-50/80', text: 'text-indigo-700' },
            { bar: 'bg-emerald-500/90', bg: 'bg-emerald-50/80', text: 'text-emerald-700' },
            { bar: 'bg-rose-500/90', bg: 'bg-rose-50/80', text: 'text-rose-700' },
            { bar: 'bg-amber-500/90', bg: 'bg-amber-50/80', text: 'text-amber-700' },
            { bar: 'bg-cyan-500/90', bg: 'bg-cyan-50/80', text: 'text-cyan-700' },
        ];
        const interviewerColor = { bar: 'bg-slate-400/90', bg: 'bg-slate-50/80', text: 'text-slate-600' };
        
        const knownSpeakers: Record<string, typeof palette[0]> = {};
        let colorIdx = 0;

        return blocks.map((b, i) => {
            if (!b.isSpeaker) {
                return b.nodes.length > 0 ? <span key={`nonspeaker-${i}`}>{b.nodes}</span> : null;
            }

            const baseName = b.label.split('•')[0].trim();
            let cStyle = interviewerColor;
            
            if (baseName !== 'INTERVIEWER') {
                if (!knownSpeakers[baseName]) {
                    knownSpeakers[baseName] = palette[colorIdx % palette.length];
                    colorIdx++;
                }
                cStyle = knownSpeakers[baseName];
            }

            let displayLabel = b.label;
            if (b.endTime) {
                const tsMatch = displayLabel.match(/(\d{2}:\d{2}(?::\d{2})?)/);
                const etMatch = b.endTime.match(/(\d{2}:\d{2}(?::\d{2})?)/);
                if (tsMatch && etMatch) {
                    displayLabel = displayLabel.replace(tsMatch[1], `${tsMatch[1]} - ${etMatch[1]}`);
                }
            }

            return (
                <div key={`block-${i}`} className="mb-4 border border-slate-200 rounded-[14px] shadow-sm bg-white overflow-hidden relative break-inside-avoid">
                    <div className={`select-none absolute top-0 left-0 bottom-0 w-1.5 ${cStyle.bar}`} />
                    <div className={`select-none ${cStyle.bg} border-b border-slate-100 px-5 py-2 font-extrabold ${cStyle.text} text-[10.5px] uppercase tracking-widest pl-6`}>
                        {displayLabel}
                    </div>
                    <div className="px-6 pt-3 pb-4 text-[14px] leading-relaxed text-slate-700">
                        {b.nodes}
                    </div>
                </div>
            );
        });
    }

    const aiModels = [
        { key: 'gpt', label: 'GPT-4o', provider: 'OpenAI', dotClass: 'bg-amber-400' },
        { key: 'claude', label: 'Claude 4.5 Haiku', provider: 'Anthropic', dotClass: 'bg-blue-400' },
        { key: 'gemini', label: 'Gemini 2.5 Flash', provider: 'Google', dotClass: 'bg-emerald-400' },
    ]

    return (
        <div className="flex bg-slate-50/50 h-full overflow-hidden w-full">
            {/* ── Main Content Area: Transcript ── */}
            <div className="flex-1 flex flex-col overflow-hidden relative border-r border-slate-200/60 shadow-sm z-10">

                {/* Header (Screenshot 1 top portion) */}
                <div className="flex items-center justify-between px-8 py-4 bg-white border-b border-slate-100 flex-shrink-0 z-20 sticky top-0">
                    <div className="flex items-center gap-4">
                        <button onClick={() => router.push(`/projects/${projectId}`)} className="text-slate-400 hover:text-indigo-600 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-left"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
                        </button>
                        <div className="w-px h-8 bg-slate-200"></div>
                        <div>
                            <div className="flex items-center gap-3">
                                <h1 className="text-lg font-extrabold text-slate-800 tracking-tight">{transcript.title}</h1>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-sm font-medium text-slate-500">
                                <span>{transcript.title.toLowerCase().replace(/\s+/g, '_')}.txt</span>
                                <button className="text-slate-400 hover:text-indigo-600 ml-1"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
                                <button className="text-slate-400 hover:text-red-500"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Export Button */}
                        <button 
                            onClick={exportTranscriptCoded}
                            className="flex items-center gap-2 px-4 py-2 border border-slate-200 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors shadow-sm bg-white"
                            title="Export as Word Document"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                            Export
                        </button>

                        {/* Analysis Dropdown Button */}
                        <div className="relative">
                            <div className={`flex items-center rounded-lg shadow-sm transition-all border border-transparent ${
                                isAnalyzing ? 'bg-indigo-400 text-white cursor-not-allowed' : 'bg-indigo-600 shadow-[0_4px_14px_0_rgba(79,70,229,0.39)] text-white hover:bg-indigo-700 hover:-translate-y-0.5'
                            }`}>
                                <button
                                    onClick={runAnalysis}
                                    disabled={isAnalyzing}
                                    className="flex items-center gap-2 text-sm font-semibold px-4 py-2"
                                >
                                    {isAnalyzing ? (
                                        <>
                                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                            </svg>
                                            Analyzing...
                                        </>
                                    ) : (
                                        <>
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-sparkles"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a4.42 4.42 0 0 1 0-8.962L8.5 1.936A2 2 0 0 0 9.937.5l1.582-6.135a4.42 4.42 0 0 1 8.962 0L22.063 8.5A2 2 0 0 0 23.5 9.937l6.135 1.582a4.42 4.42 0 0 1 0 8.962l-6.135 1.582a2 2 0 0 0-1.437 1.438l-1.582 6.135a4.42 4.42 0 0 1-8.962 0z"/></svg> 
                                            {analysisRun ? 'Re-run Analysis' : 'Run Initial Analysis'}
                                        </>
                                    )}
                                </button>
                                <button 
                                    onClick={() => setShowModelPicker(prev => !prev)} 
                                    disabled={isAnalyzing} 
                                    className="px-2 py-2 border-l border-indigo-500/50 hover:bg-indigo-500 rounded-r-lg transition-colors flex items-center justify-center cursor-pointer"
                                    aria-label="Toggle models"
                                    type="button"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                                </button>
                            </div>

                            {/* Right Sidebar Toggle */}
                            <button 
                                onClick={() => setIsRightBarCollapsed(!isRightBarCollapsed)}
                                className="ml-1 w-[38px] h-[38px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-indigo-600 hover:bg-slate-50 transition-colors shadow-sm bg-white"
                                title={isRightBarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                            >
                                {isRightBarCollapsed ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/></svg>
                                ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/></svg>
                                )}
                            </button>

                            {/* Dropdown Menu */}
                            {showModelPicker && (
                                <div className="absolute right-0 mt-2 w-72 bg-white border border-slate-200 rounded-xl shadow-lg z-[100] p-4 flex flex-col gap-3">
                                    <div className="flex flex-col gap-1">
                                        <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest px-1">Select AI Models To Run</p>
                                        <div className="flex flex-col gap-1 mt-1">
                                            {aiModels.map(m => (
                                                <label key={m.key} className="flex items-center justify-between px-2 py-2 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors">
                                                    <div className="flex items-center gap-3">
                                                        <input 
                                                            type="checkbox" 
                                                            className="w-4 h-4 rounded text-indigo-600 border-slate-300 focus:ring-indigo-500" 
                                                            checked={!!selectedModels[m.key as keyof typeof selectedModels]}
                                                            onChange={e => setSelectedModels(prev => ({ ...prev, [m.key]: e.target.checked }))}
                                                        />
                                                        <div className={`w-3 h-3 rounded-full ${m.dotClass}`} />
                                                        <span className="text-sm font-bold text-slate-700">{m.label}</span>
                                                    </div>
                                                    <span className="text-xs text-slate-400 font-medium">{m.provider}</span>
                                                </label>
                                            ))}
                                        </div>
                                        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-2 px-2">
                                            <div className="w-2.5 h-2.5 rounded-full bg-purple-500" />
                                            <span className="text-[11px] font-semibold text-slate-500">Purple underline = All models agree</span>
                                        </div>
                                    </div>
                                    <div className="border-t border-slate-100 pt-3 flex flex-col gap-2">
                                        <div className="flex items-center justify-between px-1">
                                            <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Custom AI Lens & Instructions</label>
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={() => setShowFullPrompt(!showFullPrompt)}
                                                    className={`text-[9px] font-bold transition-colors uppercase tracking-widest ${showFullPrompt ? 'text-indigo-600' : 'text-slate-400 hover:text-indigo-500'}`}
                                                >
                                                    {showFullPrompt ? 'Hide Full Prompt' : 'Show Full Prompt'}
                                                </button>
                                                <button 
                                                    onClick={() => setResearchContext('')}
                                                    className="text-[9px] font-bold text-indigo-500 hover:text-indigo-700 transition-colors uppercase tracking-widest"
                                                >
                                                    Reset
                                                </button>
                                            </div>
                                        </div>
                                        {/* Style Mode Toggle */}
                                        <div className="mb-4 p-3 rounded-xl border border-slate-200 bg-slate-50/80">
                                            <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-2.5">AI Coding Mode</p>
                                            <div className="flex rounded-xl border border-slate-200 overflow-hidden bg-white">
                                                <button
                                                    type="button"
                                                    onClick={() => setStyleMode('explore')}
                                                    className={`flex-1 flex flex-col items-start px-3 py-2 text-left transition-colors ${styleMode === 'explore' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
                                                >
                                                    <span className={`text-[11px] font-bold ${styleMode === 'explore' ? 'text-white' : 'text-slate-700'}`}>🔍 Explore Freely</span>
                                                    <span className={`text-[10px] leading-snug mt-0.5 ${styleMode === 'explore' ? 'text-indigo-200' : 'text-slate-400'}`}>AI generates fresh codes, may surface things you missed</span>
                                                </button>
                                                <div className="w-px bg-slate-200" />
                                                <button
                                                    type="button"
                                                    onClick={() => setStyleMode('style-copy')}
                                                    className={`flex-1 flex flex-col items-start px-3 py-2 text-left transition-colors ${styleMode === 'style-copy' ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
                                                >
                                                    <span className={`text-[11px] font-bold ${styleMode === 'style-copy' ? 'text-white' : 'text-slate-700'}`}>🎨 Copy My Style</span>
                                                    <span className={`text-[10px] leading-snug mt-0.5 ${styleMode === 'style-copy' ? 'text-violet-200' : 'text-slate-400'}`}>AI learns from your existing codes and matches your approach</span>
                                                </button>
                                            </div>
                                            {styleMode === 'style-copy' && (
                                                <div className="mt-2.5 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                                                    <p className="text-[10px] font-bold text-amber-700 flex items-center gap-1.5 mb-1">
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                                                        Requires existing codes to work
                                                    </p>
                                                    <p className="text-[9.5px] text-amber-600 leading-relaxed">
                                                        This mode only works well if you have <strong>already coded at least one transcript</strong> in this project (manually or by accepting AI codes). If no codes exist yet, the AI will fall back to Explore Freely.
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        <textarea
                                            value={researchContext}
                                            onChange={e => setResearchContext(e.target.value)}
                                            placeholder={"Optional: Tell the AI what to focus on.\n\nExamples:\n• \"Focus on emotional regulation strategies\"\n• \"Analyse through a CBT lens\"\n• \"Prioritise mentions of social support and relationships\"\n• \"Code only negative experiences and pain points\""}
                                            className="w-full h-28 text-xs p-2.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y font-medium custom-scrollbar leading-relaxed"
                                        />
                                        <p className="text-[9px] text-slate-400 px-0.5">↑ Give the AI a specific analytical lens. This is injected into the systematic prompt below.</p>
                                        
                                        {showFullPrompt && (
                                            <div className="mt-2">
                                                <div className="flex items-center gap-1.5 mb-1.5">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>
                                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Full Prompt Sent to AI</span>
                                                </div>
                                                <pre className="w-full max-h-64 text-[10px] p-3 border border-slate-200 rounded-lg bg-slate-50 overflow-y-auto custom-scrollbar font-mono leading-relaxed text-slate-600 whitespace-pre-wrap break-words">
                                                    {fullPromptPreview}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Transcript body (White Paper UI) */}
                <div
                    ref={transcriptBodyRef}
                    className={`flex-1 overflow-y-auto w-full flex justify-center items-start py-10 px-8 bg-slate-50/50 custom-scrollbar transition-all duration-300 ${showHighlightGuide ? 'ring-2 ring-indigo-400 ring-inset' : ''}`}
                >
                    {/* Floating guide tooltip */}
                    {showHighlightGuide && (
                        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300 pointer-events-none">
                            <div className="flex items-center gap-2 bg-slate-900 text-white text-[12px] font-bold px-4 py-2.5 rounded-full shadow-xl">
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m8 16 2.05-2.05a5.55 5.55 0 0 0-7.85-7.85L5 3"/><path d="m14 8 2.3 2.3c.9.9 2.5.9 3.4 0l.6-.6c.9-.9.9-2.5 0-3.4l-2.3-2.3"/><path d="m21 21-1-1"/><path d="m16 8 4 4"/><path d="M4 16h6v5H4v-5Z"/></svg>
                                Click &amp; drag over any text to assign a code
                            </div>
                        </div>
                    )}
                    <div className="w-full max-w-[860px] bg-white rounded-3xl px-8 pt-10 pb-16 shadow-[0_4px_24px_rgba(0,0,0,0.04)] border border-slate-100 h-fit min-h-full flex flex-col">
                        {isEditingText ? (
                            <textarea
                                value={editedContent}
                                onChange={(e) => setEditedContent(e.target.value)}
                                className="text-[14.5px] leading-[2.25rem] text-slate-700 w-full min-h-[600px] border-0 outline-none resize-none font-medium custom-scrollbar"
                                spellCheck={false}
                                placeholder="Edit your transcript here..."
                            />
                        ) : (
                            <div onClick={handleTranscriptClick} className="text-[14.5px] leading-[2.25rem] text-slate-700 whitespace-pre-wrap break-words w-full max-w-full font-medium text-left">
                                {renderTranscript()}
                            </div>
                        )}
                    </div>
                </div>

                {/* Human highlight tooltip (floating) */}
                <HumanHighlightTooltip
                    transcriptId={transcript.id}
                    projectId={projectId}
                    transcriptContent={transcript.content}
                    onCodeApplied={(segment, codeName, text) => {
                        triggerToast('Code saved! Available in Theme Builder.')
                        if (segment && codeName && text) {
                            setActivePanel({ type: 'human', text, codeName, segmentId: segment.id })
                        }
                        router.refresh()
                    }}
                />
            </div>

            {/* ── Right: Panel ── */}
            <div className={`${isRightBarCollapsed ? 'w-0 border-l-0 opacity-0' : 'w-80 border-l opacity-100'} transition-all duration-300 ease-in-out flex-shrink-0 flex flex-col bg-slate-50 border-slate-200 overflow-hidden relative`}>
                <div className="w-80 flex flex-col h-full absolute top-0 right-0">
                    {activePanel === null && (
                        <EmptyPanel analysisRun={analysisRun} onRunAnalysis={runAnalysis} isAnalyzing={isAnalyzing} stats={stats} onOpenMassReview={async (t) => {
                            setIsFetchingForReview(true);
                            await refreshSegments();
                            setIsFetchingForReview(false);
                            setShowMassReview(t);
                        }} onHighlightGuide={() => {
                            // Scroll transcript to top
                            transcriptBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                            // Flash glow ring
                            setShowHighlightGuide(true);
                            setTimeout(() => setShowHighlightGuide(false), 3000);
                        }} isFetchingForReview={isFetchingForReview} />
                    )}
                    {activePanel?.type === 'ai' && (
                        <AIComparePanel
                            key={activePanel.segment.id}
                            segment={activePanel.segment}
                            onClose={() => setActivePanel(null)}
                            onDecision={(...args) => {
                                handleDecision(...args);
                                if (args[1] === 'ACCEPT' || args[1] === 'OVERRIDE') triggerToast('Code saved! Available in Theme Builder.');
                            }}
                            projectId={projectId}
                            transcriptId={transcript.id}
                            transcriptContent={transcript.content}
                            onSupportingQuoteAdded={() => {
                                triggerToast('Supporting quote linked!')
                                router.refresh()
                            }}
                        />
                    )}
                    {activePanel?.type === 'human' && (
                        <HumanCodePanel
                            text={activePanel.text}
                            codeName={activePanel.codeName}
                            segmentId={activePanel.segmentId}
                            onClose={() => setActivePanel(null)}
                            projectId={projectId}
                            onRemove={async (segId: string) => {
                                setSegments(prev => prev.filter(s => s.id !== segId));
                                setStats(prev => ({ ...prev, totalHighlights: Math.max(0, prev.totalHighlights - 1), assignedCodes: Math.max(0, prev.assignedCodes - 1) }));
                                setActivePanel(null);
                            }}
                        />
                    )}
                </div>
            </div>

            {/* Wait screen modal */}
            {mounted && isAnalyzing && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-300">
                    <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-500 relative">
                        <button 
                            onClick={() => abortControllerRef.current?.abort()}
                            className="absolute top-5 right-5 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                        </button>
                        <div className="p-10 flex flex-col items-center text-center">
                            <div className="w-20 h-20 bg-indigo-50 rounded-2xl flex items-center justify-center mb-6 relative shadow-inner">
                                <svg className="w-10 h-10 text-indigo-500 animate-[spin_3s_linear_infinite]" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-sparkles absolute text-indigo-600"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a4.42 4.42 0 0 1 0-8.962L8.5 1.936A2 2 0 0 0 9.937.5l1.582-6.135a4.42 4.42 0 0 1 8.962 0L22.063 8.5A2 2 0 0 0 23.5 9.937l6.135 1.582a4.42 4.42 0 0 1 0 8.962l-6.135 1.582a2 2 0 0 0-1.437 1.438l-1.582 6.135a4.42 4.42 0 0 1-8.962 0z"/></svg>
                            </div>
                            
                            <h2 className="text-2xl font-extrabold text-slate-800 mb-2 tracking-tight">Running AI Analysis</h2>
                            <p className="text-sm text-slate-500 font-medium mb-10 max-w-[280px] leading-relaxed">
                                This involves calling multiple language models and computing validation checks per highlight...
                            </p>

                            <div className="w-full flex flex-col gap-5 text-left pl-2">
                                {[
                                    { label: 'Extracting Context & Formatting', detail: 'Reading research instructions & metadata' },
                                    { label: 'Generating Thematic Codes', detail: 'Running selected AI models in parallel' },
                                    { label: 'Cross-verifying & Scoring', detail: 'Checking semantic similarity & consistencies' },
                                    { label: 'Synthesizing Consensus', detail: 'Cleaning redundancies and merging duplicate codes' }
                                ].map((step, idx) => {
                                    const isActive = analyzingStep === idx;
                                    const isDone = analyzingStep > idx;
                                    
                                    return (
                                        <div key={idx} className={`flex items-start gap-4 transition-all duration-500 ease-out ${isDone || isActive ? 'opacity-100 translate-x-0' : 'opacity-30 -translate-x-2'}`}>
                                            <div className="mt-0.5 w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-full bg-slate-50 border border-slate-200">
                                                {isDone ? (
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500"><polyline points="20 6 9 17 4 12"/></svg>
                                                ) : isActive ? (
                                                    <div className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-pulse shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
                                                ) : null}
                                            </div>
                                            <div>
                                                <div className={`text-[13px] font-bold ${isActive ? 'text-indigo-600' : isDone ? 'text-slate-700' : 'text-slate-400'}`}>
                                                    {step.label}
                                                </div>
                                                <div className="text-[11px] text-slate-400 font-medium mt-0.5">
                                                    {step.detail}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>

                        </div>
                        <div className="bg-slate-50/70 p-4 border-t border-slate-100 flex items-center justify-between px-6">
                            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Expected Wait Time: ~4-7 Minutes</span>
                            <button 
                                onClick={() => abortControllerRef.current?.abort()} 
                                className="text-[10px] font-bold text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition-colors uppercase tracking-widest px-3 py-1.5 rounded-md border border-rose-100 shadow-sm bg-white"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Mass Review Modal */}
            {showMassReview !== null && (
                <MassReviewModal 
                    segments={segments.map((seg) => {
                        const speakersBefore = displaySegments.filter((s) => s.type === 'speaker' && s.startIndex <= seg.startIndex);
                        return { ...seg, speaker: speakersBefore.length > 0 && speakersBefore[speakersBefore.length - 1].type === 'speaker' ? (speakersBefore[speakersBefore.length - 1] as Extract<DisplaySegment, { type: 'speaker' }>).label.split('•')[0].trim() : null };
                    })}
                    initialTab={showMassReview}
                    transcriptTitle={transcript.title}
                    onClose={() => setShowMassReview(null)}
                    onDecision={(...args) => {
                        handleDecision(...args);
                        if (args[1] === 'ACCEPT' || args[1] === 'OVERRIDE') triggerToast('Code saved! Available in Theme Builder.');
                    }}
                    onTrace={(segId) => {
                        setShowMassReview(null);
                        const el = document.querySelector(`[data-segment-id="${segId}"]`) as HTMLElement;
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.click(); // Open the side panel for this segment
                        }
                    }}
                />
            )}

            <ConfirmModal
                isOpen={showEditConfirm}
                title="Edit Transcript"
                message="Editing the transcript may misalign existing highlights. Are you sure you want to proceed?"
                confirmText="Proceed"
                isDestructive={true}
                onConfirm={() => {
                    setShowEditConfirm(false);
                    setEditedContent(transcript.content);
                    setIsEditingText(true);
                }}
                onCancel={() => setShowEditConfirm(false)}
            />

            {/* Custom Toast Notification */}
            {mounted && toastMessage && typeof document !== 'undefined' && createPortal(
                <div className="fixed bottom-6 right-6 z-[9999] pointer-events-none">
                    <div className={`bg-slate-900 text-white px-5 py-4 rounded-xl shadow-2xl border border-slate-700/50 flex flex-col gap-1.5 min-w-[300px] transition-all duration-300 ${toastMessage.visible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
                        <div className="flex items-center gap-2">
                            <div className="w-5 h-5 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center flex-shrink-0">
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            </div>
                            <span className="text-[13px] font-bold">{toastMessage.message}</span>
                        </div>
                        <a href={`/projects/${projectId}/themes`} className="pointer-events-auto text-[11px] font-medium text-indigo-300 hover:text-indigo-200 ml-7 underline underline-offset-2 w-max transition-colors">
                            Click here to jump to Theme Builder
                        </a>
                    </div>
                </div>,
                document.body
            )}



            {/* Observation / Memo Modal */}
            {mounted && showObsPanel && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col border border-slate-200 animate-in zoom-in-95 duration-300 relative">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                            <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-violet-100 text-violet-600 rounded-md">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                                </div>
                                <div>
                                    <h3 className="text-[14px] font-extrabold text-violet-900">New Research Memo</h3>
                                    <p className="text-[11px] text-slate-500 font-medium">Capture your deductive thoughts or field notes.</p>
                                </div>
                            </div>
                            <button onClick={() => setShowObsPanel(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </div>
                        <div className="p-5 flex flex-col gap-4">
                            <div>
                                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">Observation Label <span className="text-red-500">*</span></label>
                                <input
                                    type="text"
                                    value={obsForm.label}
                                    onChange={e => setObsForm(prev => ({ ...prev, label: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter' && obsForm.label.trim()) createObservationCode() }}
                                    placeholder="e.g. Participants avoid eye contact when talking about money"
                                    className="w-full text-sm text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                                    autoFocus
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">Context & Evidence</label>
                                <textarea
                                    value={obsForm.note}
                                    onChange={e => setObsForm(prev => ({ ...prev, note: e.target.value }))}
                                    placeholder="Why are you noting this? What evidence — verbal, non-verbal, or contextual — supports this?"
                                    rows={3}
                                    className="w-full text-sm text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                                />
                            </div>
                        </div>
                        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
                            <button
                                onClick={() => setShowObsPanel(false)}
                                className="px-3 py-1.5 text-xs font-bold text-slate-600 border border-slate-200 rounded hover:bg-slate-100"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={createObservationCode}
                                disabled={!obsForm.label.trim() || obsSaving}
                                className="px-4 py-1.5 text-xs font-bold text-white bg-violet-600 rounded hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                            >
                                {obsSaving ? 'Saving...' : 'Save Memo'}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="flex items-center gap-2">
            <span className={`text-lg font-bold ${color}`}>{value}</span>
            <span className="text-[11px] text-slate-500">{label}</span>
        </div>
    )
}

function LegendDot({ color, label }: { color: string; label: string }) {
    return (
        <span className="flex items-center gap-1">
            <span className={`w-2.5 h-2.5 rounded-sm ${color} inline-block`} />
            {label}
        </span>
    )
}

function EmptyPanel({ analysisRun, onRunAnalysis, isAnalyzing, stats, onOpenMassReview, onHighlightGuide, isFetchingForReview }: {
    analysisRun: boolean
    onRunAnalysis: () => void
    isAnalyzing: boolean
    stats?: Stats
    onOpenMassReview: (tab: 'ALL' | 'PENDING' | 'ACCEPTED') => void
    onHighlightGuide: () => void
    isFetchingForReview?: boolean
}) {
    if (analysisRun && stats) {
        return (
            <div className="flex-1 flex flex-col bg-slate-50/50 relative overflow-y-auto">
                <div className="p-8 pb-12 text-center flex flex-col items-center">
                    <div className="w-16 h-16 rounded-3xl bg-indigo-50 flex items-center justify-center mb-6 shadow-sm border border-indigo-100/50 text-indigo-500 relative">
                        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-mouse-pointer-click animate-pulse"><path d="M14 4.1 12 6"/><path d="m5.1 8-2.9 1.2"/><path d="m21.3 13.7-2.6-1.5"/><path d="M22 22l-7.7-7.7"/><path d="m14.6 10.5 7.4-7.4"/></svg>
                        <div className="absolute -left-3 animate-bounce">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400"><path d="m15 18-6-6 6-6"/></svg>
                        </div>
                    </div>
                    <h3 className="text-base font-extrabold text-slate-800 tracking-tight mb-2">Review in Document</h3>
                    <p className="text-[13px] font-medium text-slate-500 leading-relaxed mb-8 px-4">
                        Click on any <span className="inline-block px-1.5 py-0.5 bg-amber-50 border border-amber-200 text-amber-600 rounded-sm text-[11px] font-bold mx-1 italic shadow-sm hover:bg-amber-100 cursor-help transition-colors">highlighted text</span> in the transcript on the left to review its AI suggestions individually, or just select new text to code by yourself.
                    </p>
                </div>

                <div className="px-6 pb-6">
                    <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-4 px-2">Transcript Progress</p>
                    <div className="space-y-3">
                        <div className={`bg-white border text-left border-slate-200 rounded-2xl p-4 flex items-center justify-between shadow-sm cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all group ${isFetchingForReview ? 'opacity-60 pointer-events-none' : ''}`} onClick={() => onOpenMassReview('ALL')}>
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center font-bold flex-shrink-0 group-hover:bg-indigo-500 group-hover:text-white transition-colors">
                                    {isFetchingForReview ? (
                                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-highlighter"><path d="m8 16 2.05-2.05a5.55 5.55 0 0 0-7.85-7.85L5 3"/><path d="m14 8 2.3 2.3c.9.9 2.5.9 3.4 0l.6-.6c.9-.9.9-2.5 0-3.4l-2.3-2.3"/><path d="m21 21-1-1"/><path d="m16 8 4 4"/><path d="M4 16h6v5H4v-5Z"/></svg>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h4 className="text-[13px] font-bold text-slate-800 truncate">Total Highlights</h4>
                                    <p className="text-[10px] text-indigo-500 font-bold truncate group-hover:underline">{isFetchingForReview ? 'Loading...' : 'Click to view all'}</p>
                                </div>
                            </div>
                            <span className="text-xl font-extrabold text-indigo-700 pl-4">{stats.totalHighlights}</span>
                        </div>
                        
                        <div className="bg-white border text-left border-slate-200 rounded-2xl p-4 flex items-center justify-between shadow-sm cursor-pointer hover:border-emerald-300 hover:bg-emerald-50/30 transition-all group" onClick={() => onOpenMassReview('ACCEPTED')}>
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-500 flex items-center justify-center font-bold flex-shrink-0 group-hover:bg-emerald-500 group-hover:text-white transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-check-circle-2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h4 className="text-[13px] font-bold text-slate-800 truncate">Assigned Codes</h4>
                                    <p className="text-[10px] text-emerald-600 font-bold truncate group-hover:underline">Click to view accepted</p>
                                </div>
                            </div>
                            <span className="text-xl font-extrabold text-emerald-700 pl-4">{stats.assignedCodes}</span>
                        </div>

                        <div className="bg-white border text-left border-slate-200 rounded-2xl p-4 flex items-center justify-between shadow-sm cursor-pointer hover:border-amber-300 hover:bg-amber-50/30 transition-all group" onClick={() => onOpenMassReview('PENDING')}>
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-500 flex items-center justify-center font-bold flex-shrink-0 group-hover:bg-amber-500 group-hover:text-white transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-clock"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h4 className="text-[13px] font-bold text-slate-800 truncate">Pending AI Review</h4>
                                    <p className="text-[10px] text-amber-600 font-bold truncate group-hover:underline">Click to mass review</p>
                                </div>
                            </div>
                            <span className="text-xl font-extrabold text-amber-600 pl-4">{stats.pendingReview}</span>
                        </div>
                    </div>

                    {/* Model Color Legend */}
                    <div className="mt-6 pt-4 border-t border-slate-100">
                        <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-3 px-2">Highlight Colors</p>
                        <div className="grid grid-cols-1 gap-1.5 text-[11px] font-medium px-1">
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded bg-amber-100 border border-amber-300 flex-shrink-0" />
                                <span className="text-slate-600">GPT-4o only</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded bg-blue-100 border border-blue-300 flex-shrink-0" />
                                <span className="text-slate-600">Claude only</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded bg-emerald-100 border border-emerald-300 flex-shrink-0" />
                                <span className="text-slate-600">Gemini only</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded bg-slate-100 border-b-2 border-b-slate-400 flex-shrink-0" />
                                <span className="text-slate-600">Multiple models agree</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded bg-indigo-50 border-b-2 border-b-purple-500 flex-shrink-0" />
                                <span className="text-slate-600">All models agree</span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="w-3.5 h-3.5 rounded bg-indigo-50 border border-indigo-400 flex-shrink-0 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                </span>
                                <span className="text-slate-600">Accepted</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex-1 flex flex-col p-8 pt-12 items-center text-center bg-slate-50/50 shadow-[-4px_0_24px_rgba(0,0,0,0.02)] z-20 overflow-y-auto">
            <div className="w-16 h-16 rounded-3xl bg-indigo-50 flex items-center justify-center mb-6 border border-indigo-100/50 shadow-inner">
                <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-sparkles text-indigo-500"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a4.42 4.42 0 0 1 0-8.962L8.5 1.936A2 2 0 0 0 9.937.5l1.582-6.135a4.42 4.42 0 0 1 8.962 0L22.063 8.5A2 2 0 0 0 23.5 9.937l6.135 1.582a4.42 4.42 0 0 1 0 8.962l-6.135 1.582a2 2 0 0 0-1.437 1.438l-1.582 6.135a4.42 4.42 0 0 1-8.962 0z"/></svg>
            </div>
            
            <h3 className="text-lg font-extrabold text-slate-800 mb-2 tracking-tight">Get started with coding</h3>
            <p className="text-sm text-slate-500 mb-10 leading-relaxed font-medium">
                Choose how you'd like to begin <br/>analysing this transcript
            </p>

            <div className="w-full flex flex-col gap-8">
                {/* Run Initial Analysis Box */}
                <div onClick={onRunAnalysis} className={`w-full p-5 rounded-[20px] text-left transition-all border shadow-sm group ${isAnalyzing ? 'border-slate-200 bg-slate-50 cursor-not-allowed opacity-70' : 'border-indigo-100 bg-white cursor-pointer hover:border-indigo-300 hover:shadow-md'}`}>
                    <div className="flex gap-4">
                        <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-100 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-sparkles"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a4.42 4.42 0 0 1 0-8.962L8.5 1.936A2 2 0 0 0 9.937.5l1.582-6.135a4.42 4.42 0 0 1 8.962 0L22.063 8.5A2 2 0 0 0 23.5 9.937l6.135 1.582a4.42 4.42 0 0 1 0 8.962l-6.135 1.582a2 2 0 0 0-1.437 1.438l-1.582 6.135a4.42 4.42 0 0 1-8.962 0z"/></svg> 
                        </div>
                        <div>
                            <h4 className="text-sm font-bold text-slate-800 mb-1">{isAnalyzing ? 'Analyzing...' : 'Run Initial Analysis'}</h4>
                            <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
                                Click the Run Initial Analysis button above to let AI suggest initial codes across the transcript automatically.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="relative">
                    <div className="absolute inset-0 flex items-center" aria-hidden="true">
                        <div className="w-full border-t border-slate-200"></div>
                    </div>
                    <div className="relative flex justify-center">
                        <span className="bg-slate-50/50 px-3 text-[10px] font-extrabold uppercase tracking-widest text-slate-300">OR</span>
                    </div>
                </div>

                {/* Highlight manually Box */}
                <div onClick={onHighlightGuide} className="w-full p-5 rounded-[20px] bg-white border border-slate-200 shadow-sm text-left hover:border-indigo-300 hover:shadow-md hover:bg-indigo-50/20 transition-all cursor-pointer group">
                    <div className="flex gap-4">
                         <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-600 flex items-center justify-center flex-shrink-0 shadow-inner group-hover:bg-indigo-100 group-hover:text-indigo-600 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-highlighter"><path d="m8 16 2.05-2.05a5.55 5.55 0 0 0-7.85-7.85L5 3"/><path d="m14 8 2.3 2.3c.9.9 2.5.9 3.4 0l.6-.6c.9-.9.9-2.5 0-3.4l-2.3-2.3"/><path d="m21 21-1-1"/><path d="m16 8 4 4"/><path d="M4 16h6v5H4v-5Z"/></svg>
                        </div>
                        <div>
                            <h4 className="text-sm font-bold text-slate-800 mb-1 group-hover:text-indigo-700 transition-colors">Highlight manually</h4>
                            <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
                                Select any text in the transcript by dragging to create a highlight and assign your own code.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    )
}
