import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/** Simple word-overlap similarity between two strings. Returns 0–1. */
function wordSimilarity(a: string, b: string): number {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    const wa = new Set(normalize(a));
    const wb = new Set(normalize(b));
    if (wa.size === 0 || wb.size === 0) return 0;
    let intersection = 0;
    wa.forEach(w => { if (wb.has(w)) intersection++; });
    return intersection / Math.min(wa.size, wb.size);
}

export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
    try {
        // Fetch all existing themes for this project (for theme hint matching)
        const existingThemes = await prisma.theme.findMany({
            where: { projectId: params.projectId },
            select: { id: true, name: true }
        })

        // Fetch all segments with any AI suggestions or human codes across all transcripts in this project
        const segments = await prisma.segment.findMany({
            where: {
                transcript: {
                    dataset: { projectId: params.projectId }
                },
                OR: [
                    { suggestions: { some: {} } },
                    { codeAssignments: { some: { aiSuggestionId: null } } }
                ]
            },
            include: {
                transcript: {
                    select: { id: true, title: true }
                },
                suggestions: {
                    orderBy: { confidence: 'desc' },
                    include: { reviewDecision: true }
                },
                codeAssignments: {
                    include: {
                        codebookEntry: {
                            select: {
                                id: true,
                                name: true,
                                themeLinks: {
                                    select: { theme: { select: { id: true, name: true } } }
                                }
                            }
                        }
                    }
                }
            },
            orderBy: { transcript: { title: 'asc' } }
        })

        // Shape: flatten to one row per segment
        const rows = segments.map(seg => {
            const humanAssignments = seg.codeAssignments.filter(c => !c.aiSuggestionId);
            const isHuman = seg.suggestions.length === 0 && humanAssignments.length > 0;
            
            let topSuggestion = seg.suggestions[0];
            
            if (isHuman) {
                const hCode = humanAssignments[0];
                topSuggestion = {
                    id: 'human-' + hCode.id,
                    label: hCode.codebookEntry.name,
                    confidence: null,
                    explanation: 'Human created',
                    uncertainty: null,
                    modelProvider: null,
                    status: 'HUMAN'
                } as any;
            } else {
                const approved = seg.suggestions.find(s => s.status === 'APPROVED' || s.status === 'MODIFIED');
                if (approved) topSuggestion = approved;
            }

            // Extract AI-suggested theme from the uncertainty JSON field
            let suggestedTheme: string | null = null;
            if (topSuggestion?.uncertainty) {
                try {
                    const parsed = JSON.parse(topSuggestion.uncertainty as string);
                    suggestedTheme = parsed?.theme || null;
                } catch { /* ignore parse errors */ }
            }

            // Find best matching existing theme using word overlap
            let matchingExistingTheme: string | null = null;
            let matchingExistingThemeId: string | null = null;
            if (suggestedTheme && existingThemes.length > 0) {
                let bestScore = 0;
                for (const t of existingThemes) {
                    const score = wordSimilarity(suggestedTheme, t.name);
                    if (score > 0.4 && score > bestScore) { // threshold: 40% word overlap
                        bestScore = score;
                        matchingExistingTheme = t.name;
                        matchingExistingThemeId = t.id;
                    }
                }
            }

            // Collect assigned themes from accepted code assignments
            const assignedThemes: { id: string; name: string }[] = []
            for (const ca of seg.codeAssignments) {
                const links = (ca.codebookEntry as any).themeLinks || []
                for (const link of links) {
                    if (link.theme && !assignedThemes.find((t: any) => t.id === link.theme.id)) {
                        assignedThemes.push({ id: link.theme.id, name: link.theme.name })
                    }
                }
            }

            return {
                segmentId: seg.id,
                text: seg.text,
                transcriptId: seg.transcript.id,
                transcriptTitle: seg.transcript.title,
                suggestion: {
                    id: topSuggestion?.id || '',
                    label: topSuggestion?.label || '',
                    confidence: topSuggestion?.confidence,
                    explanation: topSuggestion?.explanation,
                    uncertainty: topSuggestion?.uncertainty,
                    modelProvider: topSuggestion?.modelProvider,
                    status: topSuggestion?.status,
                    alternatives: (topSuggestion as any)?.alternatives || [],
                    suggestedTheme,
                    matchingExistingTheme,
                    matchingExistingThemeId,
                    assignedThemes,
                    reviewDecision: (topSuggestion as any)?.reviewDecision,
                },
                isHuman,
                codebookEntryId: humanAssignments.length > 0 ? humanAssignments[0].codebookEntry.id : (seg.codeAssignments.length > 0 ? seg.codeAssignments[0].codebookEntry.id : undefined),
                humanCodes: humanAssignments.map(c => c.codebookEntry.name),
                totalSuggestions: seg.suggestions.length,
            }
        })

        // Sort rows by action priority:
        // 1. ACCEPTED (HUMAN, APPROVED, MODIFIED)
        // 2. PENDING (SUGGESTED, UNDER_REVIEW)
        // 3. REJECTED
        rows.sort((a, b) => {
            const getRank = (status: string | undefined) => {
                if (status === 'HUMAN' || status === 'APPROVED' || status === 'MODIFIED') return 1;
                if (status === 'SUGGESTED' || status === 'UNDER_REVIEW') return 2;
                if (status === 'REJECTED') return 3;
                return 4;
            };
            
            const rankA = getRank(a.suggestion.status);
            const rankB = getRank(b.suggestion.status);
            
            if (rankA !== rankB) return rankA - rankB;
            // Secondary sort by transcript title if ranks are equal
            return a.transcriptTitle.localeCompare(b.transcriptTitle);
        });

        return NextResponse.json({ rows, total: rows.length })
    } catch (e) {
        console.error('compare-codes error', e)
        return NextResponse.json({ error: 'Failed to fetch comparison codes' }, { status: 500 })
    }
}
