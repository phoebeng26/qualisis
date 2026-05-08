'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import ThematicMatrixView from '@/components/ThematicMatrixView'
import ConfirmModal from '@/components/ConfirmModal'
import ThemeCanvas from '@/components/ThemeCanvas'
type CodeEntry = {
    id: string
    name: string
    type: string
    instances: number
    definition?: string
    participants?: { id: string, name: string }[]
    memo?: string
}

type ThemeSuggestion = {
    name: string
    tags: string[]
    description: string
    reason?: string
    confidenceScore?: number
    codes: CodeEntry[]
}

type ThemeData = {
    id: string
    name: string
    description: string | null
    memo: string | null
    status: string
    isMeta?: boolean
    parentId?: string | null
    childIds?: string[]
    children?: ThemeData[]
    positionX?: number | null
    positionY?: number | null
    codeLinks: {
        codebookEntry: {
            id: string
            name: string
            type: string
            definition?: string | null
            examplesIn?: string | null
            examplesOut?: string | null
            memo?: string | null
            _count: { codeAssignments: number }
            participants?: { id: string, name: string }[]
        }
    }[]
    participantsCount?: number
}

// Generate consistent background and text colors based on participant name or ID
function getParticipantColor(name: string) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = [
        'bg-blue-100 text-blue-700 border-blue-200',
        'bg-purple-100 text-purple-700 border-purple-200',
        'bg-pink-100 text-pink-700 border-pink-200',
        'bg-orange-100 text-orange-700 border-orange-200',
        'bg-teal-100 text-teal-700 border-teal-200',
        'bg-cyan-100 text-cyan-700 border-cyan-200',
        'bg-lime-100 text-lime-700 border-lime-200',
        'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200',
    ];
    return colors[Math.abs(hash) % colors.length];
}

// ─── CSV Export helper ──────────────────────────────────────────────────────
function escapeCell(val: string | null | undefined): string {
    const s = (val ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ')
    // Wrap in quotes if contains comma, quote or newline
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function exportCodebookCSV(themes: ThemeData[], filename = 'codebook.csv') {
    const headers = ['Theme', 'Theme Description', 'Code', 'Code Definition', 'Frequency', 'Participants', 'Participants Count']
    const rows: string[][] = []

    for (const theme of themes) {
        // Count unique participants across all codes in this theme
        const themeParticipantSet = new Set<string>()
        theme.codeLinks.forEach(l => (l.codebookEntry.participants || []).forEach(p => themeParticipantSet.add(p.name)))

        for (const link of theme.codeLinks) {
            const participants = (link.codebookEntry.participants || []).map(p => p.name).join('; ')
            rows.push([
                theme.name,
                theme.description || '',
                link.codebookEntry.name,
                link.codebookEntry.definition || '',
                String(link.codebookEntry._count?.codeAssignments || 0),
                participants,
                String((link.codebookEntry.participants || []).length),
            ])
        }

        if (theme.codeLinks.length === 0) {
            rows.push([theme.name, theme.description || '', '', '', '', '', ''])
        }
    }

    const csvContent = [headers, ...rows]
        .map(row => row.map(escapeCell).join(','))
        .join('\n')

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

function pColor(name: string) {
    const palette = [
        { bg: '#e0e7ff', text: '#4338ca' }, { bg: '#fce7f3', text: '#be185d' },
        { bg: '#fef3c7', text: '#b45309' }, { bg: '#d1fae5', text: '#065f46' },
        { bg: '#ede9fe', text: '#6d28d9' }, { bg: '#cffafe', text: '#0e7490' },
        { bg: '#fee2e2', text: '#b91c1c' }, { bg: '#d9f99d', text: '#365314' },
    ]
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
    return palette[Math.abs(hash) % palette.length]
}
function pInitials(name: string) {
    return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ─── ThemeCell: merged rowspan cell with name, description, reflection, status ─
function ThemeCell({ theme, rowSpan, projectId, onUpdate }: { theme: ThemeData; rowSpan: number; projectId: string; onUpdate: () => void }) {
    const [description, setDescription] = useState(theme.description || '')
    const [status, setStatus] = useState(theme.status || 'DRAFT')
    const [editingField, setEditingField] = useState<'description' | null>(null)
    const [draft, setDraft] = useState('')
    const [saving, setSaving] = useState(false)
    const [savedField, setSavedField] = useState<'description' | null>(null) // for flash ✓

    const themeParticipantSet = new Set<string>()
    theme.codeLinks.forEach(l => (l.codebookEntry.participants || []).forEach(p => {
        if (!p.name.toLowerCase().includes('dataset') && p.name !== 'All') {
            themeParticipantSet.add(p.id)
        }
    }))
    const participantCount = themeParticipantSet.size

    const startEdit = (field: 'description') => {
        setDraft(description)
        setEditingField(field)
        setSavedField(null)
    }

    const save = async (field: 'description', value: string) => {
        setSaving(true)
        try {
            const res = await fetch(`/api/projects/${projectId}/themes/${theme.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value })
            })
            if (res.ok) {
                setDescription(value)
                setEditingField(null)
                // Flash "Saved ✓" for 2s
                setSavedField(field)
                setTimeout(() => setSavedField(null), 2000)
                // Refresh parent to keep everything in sync
                onUpdate()
            } else {
                const err = await res.json()
                console.error('Save failed details:', err)
                alert(`Khong the luu: ${err.error || 'Unknown error'}\nDetails: ${err.details || 'Check console'}`)
            }
        } catch (e: any) {
            console.error('Save error connection:', e)
            alert('Loi ket noi khi luu description: ' + e.message)
        }
        setSaving(false)
    }

    const cycleStatus = async () => {
        const next = status === 'DRAFT' ? 'ACTIVE' : status === 'ACTIVE' ? 'FINALIZED' : 'DRAFT'
        try {
            await fetch(`/api/projects/${projectId}/themes/${theme.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next })
            })
            setStatus(next)
        } catch {}
    }

    const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
        DRAFT:     { bg: '#f1f5f9', text: '#64748b', label: 'Draft' },
        ACTIVE:    { bg: '#dbeafe', text: '#1d4ed8', label: 'Active' },
        FINALIZED: { bg: '#dcfce7', text: '#15803d', label: 'Finalized ✓' },
    }
    const st = STATUS_STYLE[status] ?? STATUS_STYLE.DRAFT

    return (
        <td className="px-5 py-4 border-b border-r border-slate-100 align-top group/theme" rowSpan={rowSpan}>
            {/* Theme name + status badge */}
            <div className="flex items-start justify-between gap-1.5 mb-1">
                <span className="text-[13px] font-extrabold text-slate-800 leading-snug">{theme.name}</span>
                <button
                    onClick={cycleStatus}
                    className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full transition-all cursor-pointer hover:opacity-80"
                    style={{ background: st.bg, color: st.text }}
                    title="Click to advance: Draft → Active → Finalized"
                >
                    {st.label}
                </button>
            </div>

            {/* Stats */}
            <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
                <span className="text-[9px] text-slate-400 font-semibold">{theme.codeLinks.length} code{theme.codeLinks.length !== 1 ? 's' : ''}</span>
                {participantCount > 0 && (
                    <span
                        className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md"
                        style={{
                            background: participantCount >= 3 ? '#d1fae5' : participantCount === 2 ? '#fef3c7' : '#fee2e2',
                            color: participantCount >= 3 ? '#065f46' : participantCount === 2 ? '#92400e' : '#991b1b'
                        }}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        {participantCount} pax
                    </span>
                )}
            </div>

            {/* Description */}
            <InlineEditField
                value={description}
                placeholder="Describe what this theme represents..."
                isEditing={editingField === 'description'}
                onStartEdit={() => startEdit('description')}
                draft={draft} setDraft={setDraft}
                onSave={() => save('description', draft)}
                onCancel={() => setEditingField(null)}
                saving={saving && editingField === 'description'}
                saved={savedField === 'description'}
                emptyClass="opacity-0 group-hover/theme:opacity-100"
                emptyLabel="+ Add description"
            />


        </td>
    )
}

// ─── Reusable inline edit field ───────────────────────────────────────────────
function InlineEditField({
    value, placeholder, isEditing, onStartEdit, draft, setDraft, onSave, onCancel,
    saving, saved = false, emptyClass = '', emptyLabel, rows = 2
}: {
    value: string; placeholder: string; isEditing: boolean
    onStartEdit: () => void; draft: string; setDraft: (v: string) => void
    onSave: () => void; onCancel: () => void; saving: boolean; saved?: boolean
    emptyClass?: string; emptyLabel?: string; rows?: number
}) {
    if (isEditing) return (
        <div>
            <textarea
                autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                placeholder={placeholder} rows={rows}
                className="w-full text-[11px] text-slate-700 bg-white border border-indigo-300 rounded-lg px-2.5 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-200 leading-relaxed"
            />
            <div className="flex gap-1.5 mt-1 items-center">
                <button onClick={onSave} disabled={saving}
                    className="text-[10px] font-bold px-2.5 py-1 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                    {saving ? (
                        <><svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg> Saving…</>
                    ) : 'Save'}
                </button>
                <button onClick={onCancel} className="text-[10px] font-bold px-2.5 py-1 border border-slate-200 text-slate-500 rounded-md hover:bg-slate-50 transition-colors">Cancel</button>
            </div>
        </div>
    )
    if (value) return (
        <div className="group/field flex items-start gap-1">
            <p className="text-[11px] text-slate-600 leading-relaxed flex-1">{value}</p>
            <button onClick={onStartEdit} className="opacity-0 group-hover/field:opacity-100 flex-shrink-0 transition-opacity text-slate-300 hover:text-indigo-500 mt-0.5" title="Edit">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </button>
        </div>
    )
    return (
        <button onClick={onStartEdit} className={`flex items-center gap-1 text-[10px] text-slate-300 hover:text-indigo-500 transition-colors ${emptyClass}`}>
            {emptyLabel ?? `+ ${placeholder.split('…')[0]}`}
        </button>
    )
}


// ─── CodebookRow: Theme | Code + Definition | Freq | Excerpt ──
function CodebookRow({ theme, link, isFirstInTheme, themeRowSpan, onTrace, projectId, onUpdate }: {
    theme: ThemeData
    link: ThemeData['codeLinks'][0]
    isFirstInTheme: boolean
    themeRowSpan: number
    onTrace: (codeId: string, codeName: string) => void
    projectId: string
    onUpdate: () => void
}) {
    const router = useRouter()
    const [excerpt, setExcerpt] = useState<{ text: string; transcriptId: string; transcriptName: string; projectId: string; segmentId: string } | null>(null)
    const [loaded, setLoaded] = useState(false)

    // Definition editing state — seed from existing data
    const [definition, setDefinition] = useState(link.codebookEntry.definition || '')
    const [isEditingDef, setIsEditingDef] = useState(false)
    const [defDraft, setDefDraft] = useState('')
    const [defSaving, setDefSaving] = useState(false)
    const defTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        let cancelled = false
        const fetchData = async () => {
            try {
                const res = await fetch(`/api/codebook/${link.codebookEntry.id}/quotes`)
                if (res.ok && !cancelled) {
                    const data = await res.json()
                    if (Array.isArray(data) && data.length > 0 && data[0].quotes?.length > 0) {
                        setExcerpt({
                            text: data[0].quotes[0].text,
                            segmentId: data[0].quotes[0].segmentId,
                            transcriptId: data[0].transcriptId,
                            transcriptName: data[0].transcriptName,
                            projectId: data[0].projectId
                        })
                    }
                }
            } catch {}
            if (!cancelled) setLoaded(true)
        }
        fetchData()
        return () => { cancelled = true }
    }, [link.codebookEntry.id])

    const startEditDef = () => {
        setDefDraft(definition)
        setIsEditingDef(true)
    }

    const saveDef = async (value: string) => {
        setDefSaving(true)
        try {
            const res = await fetch(`/api/codebook/${link.codebookEntry.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ definition: value })
            })
            if (res.ok) setDefinition(value)
        } catch {}
        setDefSaving(false)
        setIsEditingDef(false)
    }

    const participants = link.codebookEntry.participants || []
    const freq = link.codebookEntry._count?.codeAssignments || 0

    return (
        <tr className="hover:bg-slate-50/50 transition-colors group align-top">
            {/* Theme column — merged rows */}
            {isFirstInTheme && (
                <ThemeCell theme={theme} rowSpan={themeRowSpan} projectId={projectId} onUpdate={onUpdate} />
            )}

            {/* Code + Definition column */}
            <td className="px-5 py-3.5 border-b border-r border-slate-100">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-800 text-[13px] leading-snug">{link.codebookEntry.name}</span>
                        {/* Single-source warning: if only 1 participant mentioned this code */}
                        {participants.length === 1 && (
                            <span
                                className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200"
                                title="Only 1 participant mentioned this code — consider whether it's too specific or needs more evidence"
                            >
                                Single source
                            </span>
                        )}
                    </div>
                    {/* Freq badge */}
                    <span className="flex-shrink-0 text-[10px] font-extrabold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full" title={`${freq} quote${freq !== 1 ? 's' : ''} assigned`}>
                        {freq}×
                    </span>
                </div>

                {/* Definition area */}
                {isEditingDef ? (
                    <div className="mt-1.5">
                        <textarea
                            autoFocus
                            value={defDraft}
                            onChange={e => setDefDraft(e.target.value)}
                            placeholder="Describe what this code means, when to apply it..."
                            rows={3}
                            className="w-full text-[11px] text-slate-700 bg-white border border-indigo-300 rounded-lg px-2.5 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-200 leading-relaxed"
                        />
                        <div className="flex gap-1.5 mt-1.5">
                            <button
                                onClick={() => saveDef(defDraft)}
                                disabled={defSaving}
                                className="text-[10px] font-bold px-2.5 py-1 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                            >
                                {defSaving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                                onClick={() => setIsEditingDef(false)}
                                className="text-[10px] font-bold px-2.5 py-1 border border-slate-200 text-slate-500 rounded-md hover:bg-slate-50 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : definition ? (
                    <div className="group/def flex items-start gap-1.5 mt-1">
                        <p className="text-[11px] text-slate-500 leading-relaxed flex-1 italic">{definition}</p>
                        <button
                            onClick={startEditDef}
                            className="opacity-0 group-hover/def:opacity-100 flex-shrink-0 transition-opacity text-slate-300 hover:text-indigo-500"
                            title="Edit definition"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={startEditDef}
                        className="mt-1 flex items-center gap-1 text-[10px] text-slate-300 hover:text-indigo-500 transition-colors opacity-0 group-hover:opacity-100"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                        Add definition
                    </button>
                )}
            </td>

            {/* Sample Excerpt column */}
            <td className="px-5 py-3.5 border-b border-slate-100">
                {!loaded ? (
                    <span className="text-[11px] text-slate-300 italic">Loading…</span>
                ) : excerpt ? (
                    <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-3 italic">"{excerpt.text}"</p>
                        <button
                            onClick={() => router.push(`/projects/${excerpt.projectId}/transcripts/${excerpt.transcriptId}${excerpt.segmentId ? `?segment=${excerpt.segmentId}` : ''}`)}
                            title={`Source: ${excerpt.transcriptName}`}
                            className="flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-1 rounded-md hover:bg-indigo-100"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
                            Trace
                        </button>
                    </div>
                ) : (
                    <span className="text-[11px] text-slate-300 italic">No excerpt yet</span>
                )}
            </td>
        </tr>
    )
}


export default function ThemesPage() {
    const params = useParams()
    const router = useRouter()
    const projectId = params.projectId as string

    const [activeTab, setActiveTab] = useState('Review & Compare')
    const [unassignedCodes, setUnassignedCodes] = useState<CodeEntry[]>([])
    const [themes, setThemes] = useState<ThemeData[]>([])
    const [themeSuggestions, setThemeSuggestions] = useState<ThemeSuggestion[]>([])
    const [loading, setLoading] = useState(true)
    const [suggestionsLoading, setSuggestionsLoading] = useState(false)
    const [acceptingId, setAcceptingId] = useState<string | null>(null)
    const [suggestionsRemainingAfterBatch, setSuggestionsRemainingAfterBatch] = useState(0)
    const [suggestionBatchOffset, setSuggestionBatchOffset] = useState(0)
    const [suggestionsTotalUnassigned, setSuggestionsTotalUnassigned] = useState(0)
    const [acceptingAllSuggestions, setAcceptingAllSuggestions] = useState(false)
    // Selected theme in Thematic Map for drill-down
    const [mapSelectedTheme, setMapSelectedTheme] = useState<ThemeData | null>(null)

    // Pending Codes (project-wide)
    type PendingRow = {
        segmentId: string
        text: string
        transcriptId: string
        transcriptTitle: string
        suggestion: { id: string; label: string; confidence: string | null; explanation: string | null; uncertainty: string | null; modelProvider: string | null; status: string }
        isHuman: boolean
        humanCodes: string[]
        totalSuggestions: number
    }
    const [pendingCodes, setPendingCodes] = useState<PendingRow[]>([])
    const [pendingCodesLoading, setPendingCodesLoading] = useState(false)
    const [pendingAcceptingAll, setPendingAcceptingAll] = useState(false)
    const [pendingRestoringAll, setPendingRestoringAll] = useState(false)
    
    // Inline editing for Mass Review table
    // Per-row local label drafts (NOT saved until Accept is clicked)
    const [pendingLabelEdits, setPendingLabelEdits] = useState<Record<string, string>>({})
    // Per-row theme selection: { [segmentId]: { themeId?: string, newThemeName?: string } }
    const [rowThemeSelections, setRowThemeSelections] = useState<Record<string, { themeId?: string; newThemeName?: string; label?: string }>>({}) 
    const [rowThemePickerOpen, setRowThemePickerOpen] = useState<Record<string, boolean>>({})
    // Expandable AI Reliance Report rows in Rationale & Memos column
    const [expandedRationaleRows, setExpandedRationaleRows] = useState<Record<string, boolean>>({})
    // On-demand theme suggestions per row
    const [rowThemeSuggestions, setRowThemeSuggestions] = useState<Record<string, { label: string; isExisting: boolean; themeId: string | null; reasoning?: string }[]>>({})
    const [rowThemeSuggestingLoading, setRowThemeSuggestingLoading] = useState<Record<string, boolean>>({})

    const fetchPendingCodes = useCallback(async () => {
        setPendingCodesLoading(true)
        try {
            const res = await fetch(`/api/projects/${projectId}/compare-codes`)
            const data = await res.json()
            setPendingCodes(data.rows || [])
        } catch (e) {
            console.error('Failed to load pending codes', e)
        } finally {
            setPendingCodesLoading(false)
        }
    }, [projectId])

    // Load pending codes when tab is first opened
    const [pendingCodesLoaded, setPendingCodesLoaded] = useState(false)
    useEffect(() => {
        if (activeTab === 'Review & Compare' && !pendingCodesLoaded) {
            setPendingCodesLoaded(true)
            fetchPendingCodes()
        }
    }, [activeTab, pendingCodesLoaded, fetchPendingCodes])

    // handleAccept is the single commit point for ACCEPT or OVERRIDE+theme
    const handleCompareDecision = async (row: PendingRow, action: 'ACCEPT' | 'REJECT' | 'RESTORE' | 'OVERRIDE', customLabel?: string) => {
        try {
            const themeSelection = rowThemeSelections[row.segmentId]
            // If user edited the label locally, auto-upgrade action to OVERRIDE
            const draftLabel = pendingLabelEdits[row.segmentId]
            const finalLabel = customLabel || (draftLabel && draftLabel !== row.suggestion.label ? draftLabel : undefined)
            const finalAction = finalLabel && action === 'ACCEPT' ? 'OVERRIDE' : action

            const newThemeName = themeSelection?.newThemeName || null

            await fetch(`/api/segments/${row.segmentId}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    action: finalAction, 
                    customLabel: finalLabel, 
                    suggestionId: row.suggestion.id,
                    themeId: themeSelection?.themeId || null,
                    newThemeName,
                })
            })

            // Update local state to reflect new status + optimistically add assigned theme badge
            const newStatus = finalAction === 'ACCEPT' ? 'APPROVED' : finalAction === 'REJECT' ? 'REJECTED' : finalAction === 'OVERRIDE' ? 'MODIFIED' : 'SUGGESTED';

            // Build optimistic assignedThemes list
            let optimisticThemes: { id: string; name: string }[] | undefined
            if (themeSelection && (finalAction === 'ACCEPT' || finalAction === 'OVERRIDE')) {
                const existingAssigned: { id: string; name: string }[] = (row.suggestion as any).assignedThemes || []
                if (themeSelection.themeId && themeSelection.label) {
                    const alreadyIn = existingAssigned.find(t => t.id === themeSelection.themeId)
                    optimisticThemes = alreadyIn ? existingAssigned : [...existingAssigned, { id: themeSelection.themeId, name: themeSelection.label }]
                } else if (newThemeName) {
                    const alreadyIn = existingAssigned.find(t => t.name === newThemeName)
                    optimisticThemes = alreadyIn ? existingAssigned : [...existingAssigned, { id: 'new-' + Date.now(), name: newThemeName }]
                }
            }

            setPendingCodes(prev => prev.map(r => {
                if (r.segmentId === row.segmentId) {
                    return { 
                        ...r, 
                        suggestion: { 
                            ...r.suggestion, 
                            status: newStatus,
                            label: finalLabel || r.suggestion.label,
                            ...(optimisticThemes !== undefined ? { assignedThemes: optimisticThemes } : {})
                        } 
                    };
                }
                return r;
            }))

            // Clear per-row state after commit
            if (finalAction !== 'RESTORE') {
                setPendingLabelEdits(prev => { const n = {...prev}; delete n[row.segmentId]; return n; })
                setRowThemeSelections(prev => { const n = {...prev}; delete n[row.segmentId]; return n; })
                setRowThemePickerOpen(prev => { const n = {...prev}; delete n[row.segmentId]; return n; })
                setRowThemeSuggestions(prev => { const n = {...prev}; delete n[row.segmentId]; return n; })
            }

            // If a new theme was created, refresh the themes list so it appears in Theme Builder
            if (newThemeName && (finalAction === 'ACCEPT' || finalAction === 'OVERRIDE')) {
                fetchData()
            }
        } catch (error) {
            console.error('Failed to save review decision:', error)
        }
    }

    const handleSuggestThemes = async (row: PendingRow) => {
        setRowThemeSuggestingLoading(prev => ({ ...prev, [row.segmentId]: true }))
        try {
            const res = await fetch(`/api/projects/${projectId}/suggest-themes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codeLabel: row.suggestion.label, excerpt: row.text })
            })
            const data = await res.json()
            if (data.suggestions?.length > 0) {
                setRowThemeSuggestions(prev => ({ ...prev, [row.segmentId]: data.suggestions }))
                // Auto-pre-select the first existing match if any
                const firstExisting = data.suggestions.find((s: any) => s.isExisting && s.themeId)
                if (firstExisting && !rowThemeSelections[row.segmentId]) {
                    setRowThemeSelections(prev => ({ ...prev, [row.segmentId]: { themeId: firstExisting.themeId, label: firstExisting.label } }))
                }
            }
        } catch (e) {
            console.error('suggest-themes error:', e)
        } finally {
            setRowThemeSuggestingLoading(prev => ({ ...prev, [row.segmentId]: false }))
        }
    }

    const handleAcceptAllPending = async () => {
        setPendingAcceptingAll(true)
        try {
            const pendingOnly = pendingCodes.filter(r => r.suggestion.status === 'SUGGESTED' || r.suggestion.status === 'UNDER_REVIEW')
            for (const row of pendingOnly) {
                await fetch(`/api/segments/${row.segmentId}/review`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'ACCEPT', newLabel: row.suggestion.label, suggestionId: row.suggestion.id })
                })
            }
            setPendingCodes(prev => prev.map(r => {
                if (r.suggestion.status === 'SUGGESTED' || r.suggestion.status === 'UNDER_REVIEW') {
                    return { ...r, suggestion: { ...r.suggestion, status: 'APPROVED' } }
                }
                return r;
            }))
        } catch (e) { console.error(e) }
        finally { setPendingAcceptingAll(false) }
    }

    const handleRestoreAll = async () => {
        if (!confirm('Are you sure you want to restore all decisions? This will undo all Accepted, Rejected, and Modified codes.')) return;
        setPendingRestoringAll(true)
        try {
            const actedOnly = pendingCodes.filter(r => r.suggestion.status === 'APPROVED' || r.suggestion.status === 'MODIFIED' || r.suggestion.status === 'REJECTED')
            for (const row of actedOnly) {
                await fetch(`/api/segments/${row.segmentId}/review`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'RESTORE', suggestionId: row.suggestion.id })
                })
            }
            setPendingCodes(prev => prev.map(r => {
                if (r.suggestion.status === 'APPROVED' || r.suggestion.status === 'MODIFIED' || r.suggestion.status === 'REJECTED') {
                    return { ...r, suggestion: { ...r.suggestion, status: 'SUGGESTED' } }
                }
                return r;
            }))
        } catch (e) { console.error(e) }
        finally { setPendingRestoringAll(false) }
    }

    // Panel collapse states
    const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true)
    const [isRightPanelOpen, setIsRightPanelOpen] = useState(false)

    const [themeSearchQuery, setThemeSearchQuery] = useState('')
    const [unassignedSearch, setUnassignedSearch] = useState('')
    const [expandedThemes, setExpandedThemes] = useState<Record<string, boolean>>({})

    const [synthModalOpen, setSynthModalOpen] = useState(false)
    const [synthLoading, setSynthLoading] = useState(false)
    const [synthSuggestions, setSynthSuggestions] = useState<any[]>([])
    const [synthAcceptingId, setSynthAcceptingId] = useState<number | null>(null)
    const [lastMergedThemeId, setLastMergedThemeId] = useState<string | null>(null)
    const [undoingMerge, setUndoingMerge] = useState(false)

    // Drag-over state: tracks which card is being hovered during a drag
    const [dragOverThemeId, setDragOverThemeId] = useState<string | null>(null)
    // What type of thing is being dragged: 'code'
    const [draggingType, setDraggingType] = useState<'code' | null>(null)
    const [draggingCodeId, setDraggingCodeId] = useState<string | null>(null)
    const [draggingFromThemeId, setDraggingFromThemeId] = useState<string | null>(null)

    const visibleThemes = useMemo(() => {
        if (!themeSearchQuery.trim()) return themes;
        const q = themeSearchQuery.toLowerCase();
        return themes.filter(t => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q) || t.codeLinks?.some(link => link.codebookEntry.name.toLowerCase().includes(q)));
    }, [themes, themeSearchQuery])

    // Theme Modal states (used for both create and edit)
    const [newThemeModal, setNewThemeModal] = useState({ open: false, id: undefined as string | undefined, name: '', description: '' })
    const [inlineThemeInput, setInlineThemeInput] = useState({ isOpen: false, name: '' })

    // Prompt editor state for theme suggestions
    const DEFAULT_THEME_PROMPT = `Group these codes into meaningful THEMES.

For each suggested theme, provide:
- A clear theme name. MUST be a plain-English, conversational sentence stating the core idea directly (e.g. "Users distrust AI because it feels opaque"). DO NOT use academic titles or jargon like "Dynamics of...", "Role of...", or "Patterns in...".
- 1-2 emotional/conceptual tags
- A brief description explaining WHY these codes belong together
- Which specific code names belong in this theme

Rules:
- Each code should appear in at most ONE theme
- A theme should have at least 2 codes
- Exhaustive Coverage: Create AS MANY themes as you need to group as many of the provided codes as possible. Leave nothing behind if it fits.`
    const [themePrompt, setThemePrompt] = useState(DEFAULT_THEME_PROMPT)
    const [showPromptEditor, setShowPromptEditor] = useState(false)

    // Trace modal states
    const [tracingCode, setTracingCode] = useState<{id: string, name: string} | null>(null)
    const [tracingQuotes, setTracingQuotes] = useState<any[]>([])
    const [tracingLoading, setTracingLoading] = useState(false)

    // Observation Code creation panel state
    const [showObsPanel, setShowObsPanel] = useState(false)
    const [obsForm, setObsForm] = useState({ label: '', note: '', context: '' })
    const [obsSaving, setObsSaving] = useState(false)

    // Code Deletion state
    const [codeToDelete, setCodeToDelete] = useState<{id: string, name: string} | null>(null)
    const [themeToDelete, setThemeToDelete] = useState<{id: string, name: string} | null>(null)

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
                    examplesIn: '',
                    examplesOut: '',
                })
            })
            setObsForm({ label: '', note: '', context: '' })
            setShowObsPanel(false)
            fetchData()
        } catch {}
        setObsSaving(false)
    }







    // Code Drag & Drop Helpers
    const handleDragStart = (e: React.DragEvent, payload: { codeId: string, fromThemeId?: string }) => {
        e.stopPropagation()
        e.dataTransfer.setData('application/json', JSON.stringify(payload))
        e.dataTransfer.effectAllowed = 'move'
        setDraggingType('code')
        setDraggingCodeId(payload.codeId)
        setDraggingFromThemeId(payload.fromThemeId ?? null)
    }

    const handleDragEnd = () => {
        setDraggingType(null)
        setDragOverThemeId(null)
        setDraggingCodeId(null)
        setDraggingFromThemeId(null)
    }

    const handleDragOver = (e: React.DragEvent, themeId?: string) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (themeId) setDragOverThemeId(themeId)
    }

    const handleDragLeave = (e: React.DragEvent, themeId?: string) => {
        // Only clear if we actually left the card (not just a child element)
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            if (themeId && dragOverThemeId === themeId) setDragOverThemeId(null)
        }
    }

    const handleDropToRoot = async (e: React.DragEvent) => {
        e.preventDefault()
        setDragOverThemeId(null)
        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'))

            // If dragging code from a theme -> Root: remove code from theme
            if (data.fromThemeId && data.codeId) {
                await fetch(`/api/projects/${projectId}/themes`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ themeId: data.fromThemeId, action: 'REMOVE_CODE', codeId: data.codeId })
                })
                fetchData()
            }
        } catch (err) {}
    }

    const handleDropOnTheme = async (e: React.DragEvent, targetThemeId: string) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOverThemeId(null)
        setDraggingType(null)
        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'))

            // Dragging a Code
            if (!data.codeId) return
            if (data.fromThemeId === targetThemeId) return // Already in this theme
            
            // If moving from another theme, remove from old theme first
            if (data.fromThemeId) {
                await fetch(`/api/projects/${projectId}/themes`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ themeId: data.fromThemeId, action: 'REMOVE_CODE', codeId: data.codeId })
                })
            }
            // Add to new theme
            await fetch(`/api/projects/${projectId}/themes`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ themeId: targetThemeId, action: 'ADD_CODE', codeId: data.codeId })
            })
            fetchData()
        } catch (err) {}
    }

    // Save a new or updated theme via modal
    const saveTheme = async () => {
        const finalName = newThemeModal.name.trim() || 'Untitled Theme'
        
        if (newThemeModal.id) {
            await fetch(`/api/projects/${projectId}/themes/${newThemeModal.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    name: finalName,
                    description: newThemeModal.description.trim()
                })
            })
        } else {
            await fetch(`/api/projects/${projectId}/themes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    name: finalName,
                    description: newThemeModal.description.trim(),
                    isMeta: false
                })
            })
        }
        setNewThemeModal({ open: false, id: undefined, name: '', description: '' })
        fetchData()
    }

    const createInlineTheme = async () => {
        const finalName = inlineThemeInput.name.trim() || 'Untitled Theme'
        await fetch(`/api/projects/${projectId}/themes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name: finalName,
                description: '',
                isMeta: false
            })
        });
        setInlineThemeInput({ isOpen: false, name: '' });
        fetchData();
    }

    const handleDropOnNewTheme = async (e: React.DragEvent) => {
        e.preventDefault();
        setDragOverThemeId(null);
        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));
            if (data.codeId) {
                const res = await fetch(`/api/projects/${projectId}/themes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Untitled Theme', description: '', isMeta: false })
                });
                const newTheme = await res.json();
                if (data.fromThemeId) {
                    await fetch(`/api/projects/${projectId}/themes`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ themeId: data.fromThemeId, action: 'REMOVE_CODE', codeId: data.codeId })
                    });
                }
                await fetch(`/api/projects/${projectId}/themes`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ themeId: newTheme.id, action: 'ADD_CODE', codeId: data.codeId })
                });
                fetchData();
            }
        } catch (err) {}
    }

    const handleCanvasDropCode = async (themeId: string, codeId: string, fromThemeId?: string) => {
        if (fromThemeId === themeId) return
        if (fromThemeId) {
            await fetch(`/api/projects/${projectId}/themes`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ themeId: fromThemeId, action: 'REMOVE_CODE', codeId })
            })
        }
        await fetch(`/api/projects/${projectId}/themes`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ themeId, action: 'ADD_CODE', codeId })
        })
        fetchData()
    }

    const handleCanvasDropOnEmpty = async (codeId: string, x: number, y: number, fromThemeId?: string) => {
        // Create new theme at that canvas position, assign the code
        const res = await fetch(`/api/projects/${projectId}/themes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Untitled Theme', description: '', isMeta: false, positionX: x, positionY: y })
        })
        const newTheme = await res.json()
        if (fromThemeId) {
            await fetch(`/api/projects/${projectId}/themes`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ themeId: fromThemeId, action: 'REMOVE_CODE', codeId })
            })
        }
        await fetch(`/api/projects/${projectId}/themes`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ themeId: newTheme.id, action: 'ADD_CODE', codeId })
        })
        fetchData()
    }

    const handleCanvasPositionSave = async (themeId: string, x: number, y: number) => {
        await fetch(`/api/projects/${projectId}/themes/${themeId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionX: x, positionY: y })
        })
    }

    const handleCanvasCreateTheme = async (name: string, x: number, y: number) => {
        await fetch(`/api/projects/${projectId}/themes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name || 'Untitled Theme', description: '', isMeta: false, positionX: x, positionY: y })
        })
        fetchData()
    }

    const handleCanvasRemoveCode = async (themeId: string, codeId: string) => {
        await fetch(`/api/projects/${projectId}/themes`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ themeId, action: 'REMOVE_CODE', codeId })
        })
        fetchData()
    }

    // Delete a theme
    const deleteTheme = async (themeId: string, themeName: string) => {
        setThemeToDelete({ id: themeId, name: themeName })
    }

    // Load Quotes for a specific Code
    const openTrace = async (codeId: string, codeName: string) => {
        setTracingCode({ id: codeId, name: codeName })
        setTracingLoading(true)
        setTracingQuotes([])
        try {
            const res = await fetch(`/api/codebook/${codeId}/quotes`)
            if (res.ok) {
                const data = await res.json()
                setTracingQuotes(data)
            }
        } catch (err) {}
        setTracingLoading(false)
    }

    // Fetch codebook entries + existing themes
    const fetchData = useCallback(async () => {
        setLoading(true)
        try {
            const [codesRes, themesRes] = await Promise.all([
                fetch(`/api/codebook?projectId=${projectId}`, { cache: 'no-store' }),
                fetch(`/api/projects/${projectId}/themes`, { cache: 'no-store' })
            ])

            const allCodes = await codesRes.json()
            const allThemes = await themesRes.json()

            setThemes(Array.isArray(allThemes) ? allThemes : [])

            // Determine which codes are already assigned to themes
            // NOTE: Must also include codes in children (sub-themes of Mega-Themes) —
            // otherwise those codes appear as "unassigned" in the UI but the API sees them as assigned,
            // causing "Generate Suggestions" to return an empty list silently.
            const assignedCodeIds = new Set<string>()
            if (Array.isArray(allThemes)) {
                allThemes.forEach((theme: ThemeData) => {
                    theme.codeLinks?.forEach(link => {
                        assignedCodeIds.add(link.codebookEntry.id)
                    })
                    // Also collect codes from sub-themes (children of Mega-Themes)
                    ;(theme as any).children?.forEach((child: ThemeData) => {
                        child.codeLinks?.forEach(link => {
                            assignedCodeIds.add(link.codebookEntry.id)
                        })
                    })
                })
            }

            // Filter to unassigned codes only
            const unassigned = (Array.isArray(allCodes) ? allCodes : [])
                .filter((c: any) => !assignedCodeIds.has(c.id))
                .map((c: any) => ({
                    id: c.id,
                    name: c.name,
                    // Rely entirely on the type computed and returned by the API
                    type: c.type,
                    instances: c._count?.codeAssignments ?? 0,
                    definition: c.definition,
                    participants: c.participants
                }))

            setUnassignedCodes(unassigned)

        } catch (e) {
            console.error('Failed to fetch data:', e)
        } finally {
            setLoading(false)
        }
    }, [projectId])

    useEffect(() => {
        fetchData()
    }, [fetchData])

    // localStorage helpers for persisting suggestions per project
    const STORAGE_KEY = `qualisis_suggestions_${projectId}`
    const REJECTED_KEY = `qualisis_rejected_${projectId}`

    const getRejectedNames = (): Set<string> => {
        try { return new Set(JSON.parse(localStorage.getItem(REJECTED_KEY) || '[]')) } catch { return new Set() }
    }
    const addRejectedName = (name: string) => {
        try {
            const rejected = getRejectedNames()
            rejected.add(name)
            localStorage.setItem(REJECTED_KEY, JSON.stringify(Array.from(rejected)))
        } catch {}
    }
    const saveSuggestionsCache = (suggestions: ThemeSuggestion[]) => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(suggestions)) } catch {}
    }
    const loadSuggestionsCache = (): ThemeSuggestion[] => {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
    }
    const clearSuggestionsCache = () => {
        try { localStorage.removeItem(STORAGE_KEY) } catch {}
    }

    // Generate AI theme suggestions
    // batchOffset: 0 = fresh run; >0 = load next batch appended to existing
    const generateSuggestions = useCallback(async (clearCache = false, batchOffset = 0) => {
        if (clearCache) {
            clearSuggestionsCache()
            setSuggestionBatchOffset(0)
            setSuggestionsRemainingAfterBatch(0)
            setSuggestionsTotalUnassigned(0)
            if (batchOffset === 0) setThemeSuggestions([])
        }
        setSuggestionsLoading(true)
        try {
            const res = await fetch(`/api/projects/${projectId}/themes/suggest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customPrompt: themePrompt,
                    rejectedNames: Array.from(getRejectedNames()),
                    batchOffset
                })
            })
            const textRaw = await res.text()
            let data
            try {
                data = JSON.parse(textRaw)
            } catch (jsonErr) {
                alert(`Server crashed (Likely Next.js compilation error):\n${textRaw.slice(0, 150)}...`)
                throw new Error("Server returned non-JSON response")
            }

            if (!res.ok) {
                alert(`Error from API: ${data.error || 'Unknown error'}\nDetails: ${data.details || ''}`)
                throw new Error(data.error)
            }
            const rejected = getRejectedNames()
            const incoming = (data.suggestions || []).filter((s: ThemeSuggestion) => !rejected.has(s.name))

            // If API returned empty suggestions with a reason message, log it for debugging
            if (incoming.length === 0 && data.message) {
                console.warn('[Suggest API] No suggestions returned:', data.message)
            }

            if (batchOffset === 0) {
                // Fresh run — replace all suggestions
                setThemeSuggestions(incoming)
                saveSuggestionsCache(incoming)
            } else {
                // Appending next batch
                setThemeSuggestions(prev => {
                    const merged = [...prev, ...incoming]
                    saveSuggestionsCache(merged)
                    return merged
                })
            }

            // Track remaining codes for "Load more" button
            setSuggestionsRemainingAfterBatch(data.remainingAfterBatch ?? 0)
            setSuggestionsTotalUnassigned(data.totalUnassigned ?? 0)
            const nextOffset = (data.batchOffset ?? 0) + (data.batchSize ?? incoming.length)
            setSuggestionBatchOffset(nextOffset)
        } catch (e) {
            console.error('Failed to generate suggestions:', e)
        } finally {
            setSuggestionsLoading(false)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, themePrompt])

    // Restore suggestions from cache ONCE on first load
    const hasRestored = React.useRef(false)
    useEffect(() => {
        if (!hasRestored.current && !loading) {
            hasRestored.current = true
            const cached = loadSuggestionsCache()
            if (cached.length > 0) {
                // Restore from cache — filter out rejected ones
                const rejected = getRejectedNames()
                const visible = cached.filter(s => !rejected.has(s.name))
                if (visible.length > 0) {
                    setThemeSuggestions(visible)
                } else {
                    clearSuggestionsCache()
                }
            }
        }
    }, [loading])

    // Clean up stale suggestions real-time when a code is assigned (accepted/dragged)
    useEffect(() => {
        if (!loading) {
            const unassignedIds = new Set(unassignedCodes.map(c => c.id));

            setThemeSuggestions(prev => {
                if (prev.length === 0) return prev;

                const cleaned = prev.map(suggestion => {
                    const newCodes = suggestion.codes.filter(c => unassignedIds.has(c.id));
                    return { ...suggestion, codes: newCodes };
                }).filter(suggestion => suggestion.codes.length >= 2);

                const isChanged = cleaned.length !== prev.length ||
                    cleaned.some((s, i) => {
                        // Find the same suggestion in prev by name (stable ID)
                        const original = prev.find(p => p.name === s.name)
                        return original ? s.codes.length !== original.codes.length : true
                    });

                if (isChanged) {
                    // Also persist the cleaned version to cache
                    saveSuggestionsCache(cleaned)
                    return cleaned
                }
                return prev;
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unassignedCodes, loading]);


    // Accept a theme suggestion → create theme in DB
    const acceptSuggestion = async (suggestionName: string) => {
        const suggestion = themeSuggestions.find(s => s.name === suggestionName)
        if (!suggestion) return

        // Verify if any codes from the suggestion are already assigned
        const codeIds = suggestion.codes.map(c => c.id)
        const activeCodeIdsInSuggestion = unassignedCodes.filter(c => codeIds.includes(c.id)).map(c => c.id)

        if (activeCodeIdsInSuggestion.length === 0) {
            alert('Không thể tạo Theme này vì toàn bộ codes trong gợi ý đã được phân loại vào các Themes khác.')
            setThemeSuggestions(prev => {
                const updated = prev.filter(s => s.name !== suggestionName)
                saveSuggestionsCache(updated)
                return updated
            })
            return
        }

        // Calculate a nice position based on the suggestion's index
        const index = themeSuggestions.findIndex(s => s.name === suggestionName)
        const maxExistingY = themes.reduce((max, t, i) => Math.max(max, (t as any).positionY ?? (Math.floor(i / 4) * 380 + 40)), -400)
        const startY = themes.length > 0 ? maxExistingY + 440 : 40;
        const x = (index % 3) * 380 + 100;
        const y = Math.floor(index / 3) * 380 + startY;

        setAcceptingId(suggestionName)
        try {
            const res = await fetch(`/api/projects/${projectId}/themes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: suggestion.name,
                    description: suggestion.description,
                    codeIds: activeCodeIdsInSuggestion,
                    positionX: x,
                    positionY: y
                })
            })

            const data = await res.json()

            if (res.ok) {
                // Filter by NAME (stable)
                setThemeSuggestions(prev => {
                    const updated = prev.filter(s => s.name !== suggestionName)
                    saveSuggestionsCache(updated)
                    return updated
                })
                // Refresh data to update unassigned list + theme map
                await fetchData()
            } else {
                console.error('Accept suggestion failed:', data)
                alert(`Không thể tạo theme: ${data.error || 'Unknown error'}\n${data.details || ''}`)
            }
        } catch (e: any) {
            console.error('Failed to accept theme (network error):', e)
            alert('Lỗi kết nối khi tạo theme: ' + e.message)
        } finally {
            setAcceptingId(null)
        }
    }

    const acceptAllSuggestions = async () => {
        setAcceptingAllSuggestions(true)
        
        let maxExistingY = themes.reduce((max, t, i) => Math.max(max, (t as any).positionY ?? (Math.floor(i / 4) * 380 + 40)), -400)
        const startY = themes.length > 0 ? maxExistingY + 440 : 40;
        
        const suggestionsToAccept = [...themeSuggestions]
        let successCount = 0

        for (let i = 0; i < suggestionsToAccept.length; i++) {
            const suggestion = suggestionsToAccept[i]
            const codeIds = suggestion.codes.map((c: any) => c.id)
            const activeCodeIdsInSuggestion = unassignedCodes.filter(c => codeIds.includes(c.id)).map(c => c.id)

            if (activeCodeIdsInSuggestion.length === 0) {
                continue;
            }

            const x = (i % 3) * 380 + 100;
            const y = Math.floor(i / 3) * 380 + startY;

            try {
                const res = await fetch(`/api/projects/${projectId}/themes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: suggestion.name,
                        description: suggestion.description,
                        codeIds: activeCodeIdsInSuggestion,
                        positionX: x,
                        positionY: y
                    })
                })
                if (res.ok) {
                    successCount++;
                }
            } catch (e) {
                console.error("Failed to accept suggestion in batch", e)
            }
        }
        
        setThemeSuggestions([])
        clearSuggestionsCache()
        await fetchData()
        setAcceptingAllSuggestions(false)
    }

    const rejectSuggestion = (name: string) => {
        addRejectedName(name)
        // Filter by NAME (stable)
        setThemeSuggestions(prev => {
            const updated = prev.filter(s => s.name !== name)
            saveSuggestionsCache(updated)
            return updated
        })
    }

    // AI Synthesize Themes (Meta-Themes)
    const handleSynthesize = async () => {
        setSynthModalOpen(true)
        setSynthLoading(true)
        setSynthSuggestions([])
        try {
            const res = await fetch(`/api/projects/${projectId}/themes/synthesize`, { method: 'POST' })
            if (res.ok) {
                const data = await res.json()
                setSynthSuggestions(data.suggestions || [])
            }
        } catch (e) { }
        setSynthLoading(false)
    }

    const acceptSynth = async (index: number) => {
        setSynthAcceptingId(index)
        const sg = synthSuggestions[index]
        try {
            if (!sg.matchedIds || sg.matchedIds.length < 2) {
                console.error('Merge cancelled: matchedIds is empty or too short', sg.matchedIds)
                alert('Cannot merge: themes could not be matched. Please click Synthesize Themes again to refresh.')
                setSynthAcceptingId(null)
                return
            }
            const res = await fetch(`/api/projects/${projectId}/themes/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: sg.name,
                    description: sg.description,
                    mergedThemeIds: sg.matchedIds
                })
            })
            if (res.ok) {
                const data = await res.json()
                setSynthSuggestions(prev => prev.filter((_, i) => i !== index))
                setLastMergedThemeId(data.newThemeId || null)
                await fetchData()
                if (synthSuggestions.length <= 1) setSynthModalOpen(false)
            } else {
                const errText = await res.text()
                console.error('Merge API error:', res.status, errText)
                alert(`Merge failed (${res.status}). Please try Synthesize Themes again.`)
            }
        } catch (e) {
            console.error('Merge exception:', e)
        }
        setSynthAcceptingId(null)
    }

    // Reset all AI suggestions to blank state — call this whenever codes are returned to unassigned
    // (theme deleted or mega-theme dissolved), because old suggestions are stale.
    const resetSuggestions = () => {
        clearSuggestionsCache()
        setThemeSuggestions([])
        setSuggestionBatchOffset(0)
        setSuggestionsRemainingAfterBatch(0)
        setSuggestionsTotalUnassigned(0)
    }

    const handleUndoMerge = async () => {
        if (!lastMergedThemeId) return
        setUndoingMerge(true)
        try {
            const res = await fetch(`/api/projects/${projectId}/themes/undo-merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ themeId: lastMergedThemeId })
            })
            if (res.ok) {
                setLastMergedThemeId(null)
                await fetchData()
            }
        } catch (e) {}
        setUndoingMerge(false)
    }

    const totalCodes = unassignedCodes.length + themes.reduce((acc, t) => {
        const ownCodes = t.codeLinks?.length || 0
        const childCodes = (t.children || []).reduce((s, c) => s + (c.codeLinks?.length || 0), 0)
        return acc + ownCodes + childCodes
    }, 0)
    
    // Total themes created including both top-level and children inside Mega-Themes
    const totalThemesCount = themes.reduce((acc, t) => acc + 1 + (t.children?.length || 0), 0)
    
    const assignedCount = themes.reduce((acc, t) => {
        const ownCodes = t.codeLinks?.length || 0
        const childCodes = (t.children || []).reduce((s, c) => s + (c.codeLinks?.length || 0), 0)
        return acc + ownCodes + childCodes
    }, 0)

    return (
        <div className="flex h-full bg-white text-slate-800">
            {/* Main Content Column */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Header */}
                <div className="flex-shrink-0 border-b border-slate-200 bg-white">
                    <div className="px-8 flex items-center justify-between h-20">
                        <h1 className="text-[22px] font-extrabold tracking-tight">② Themes & Analysis</h1>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => exportCodebookCSV(themes, `codebook_${projectId}.csv`)}
                                className="flex items-center gap-2 bg-white border border-slate-200 text-slate-500 px-3.5 py-2.5 rounded-lg text-sm font-bold shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors"
                                title="Export codebook to CSV"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                                Export CSV
                            </button>
                            
                            {/* Focus input + Suggest button group */}
                            <div className="flex items-center gap-0 border border-indigo-200 bg-indigo-50 rounded-lg shadow-sm overflow-hidden">
                                <input
                                    type="text"
                                    value={themePrompt === DEFAULT_THEME_PROMPT ? '' : themePrompt}
                                    onChange={e => setThemePrompt(e.target.value || DEFAULT_THEME_PROMPT)}
                                    placeholder="Focus on… (e.g. barriers to adoption)"
                                    className="bg-transparent text-[12px] font-medium text-indigo-800 placeholder:text-indigo-300 px-3 py-2.5 w-44 focus:outline-none focus:w-64 transition-all duration-300"
                                    title="Tell AI what to focus on when grouping codes into themes"
                                />
                                <button
                                    onClick={() => {
                                        if (suggestionsLoading) return;
                                        generateSuggestions(true)
                                    }}
                                    disabled={suggestionsLoading}
                                    className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-bold transition-all border-l border-indigo-200 ${
                                        themeSuggestions.length > 0
                                            ? 'bg-emerald-50 text-emerald-700 cursor-default'
                                            : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                                    }`}
                                    title="Let AI analyze all unassigned codes and suggest themes"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                                    {suggestionsLoading ? 'Analyzing...' : themeSuggestions.length > 0 ? 'Themes Suggested' : 'Suggest Themes'}
                                </button>
                            </div>

                            <button
                                onClick={() => setNewThemeModal({ open: true, name: '', description: '', id: undefined })}
                                className="flex items-center gap-1.5 bg-indigo-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold shadow-sm hover:bg-indigo-700 transition-all"
                                title="Create a new theme manually"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                                New Theme
                            </button>
                        </div>
                    </div>

                    
                    <div className="px-8 flex items-center justify-between">
                        <div className="flex items-center space-x-8">
                            {['Review & Compare', 'Build Themes', 'Analyze Relationships'].map(tab => (
                                <button 
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={`py-4 text-[13px] font-bold border-b-2 transition-colors flex items-center gap-2 ${activeTab === tab ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                                >
                                    {tab === 'Build Themes' && <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={activeTab === 'Build Themes' ? "text-indigo-600" : "text-slate-400"}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>}
                                    {tab === 'Analyze Relationships' && <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={activeTab === 'Analyze Relationships' ? "text-indigo-600" : "text-slate-400"}><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>}
                                    {tab === 'Review & Compare' && (
                                        <span className="relative">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={activeTab === 'Review & Compare' ? "text-indigo-600" : "text-slate-400"}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                            {pendingCodes.length > 0 && <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-amber-400 rounded-full text-[8px] font-extrabold text-white flex items-center justify-center">{pendingCodes.length > 9 ? '9+' : pendingCodes.length}</span>}
                                        </span>
                                    )}
                                    {tab}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Tab-Content Area — relative so overlays only cover this area, not the header/tabs above */}
                <div className="flex-1 overflow-hidden relative">
                {/* Pending Codes Tab — project-wide AI suggestion review */}
                {activeTab === 'Review & Compare' && (
                    <div className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-slate-50">
                        {/* Sub-header */}
                        <div className="flex items-center justify-between px-8 py-4 bg-white border-b border-slate-200 flex-shrink-0">
                            <div>
                                <h2 className="text-[15px] font-extrabold text-slate-800">Mass Review & Comparison</h2>
                                <p className="text-[12px] text-slate-400 font-medium mt-0.5">
                                    Mass review AI suggestions and compare them against your manual codes across all transcripts.
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={fetchPendingCodes}
                                    disabled={pendingCodesLoading}
                                    className="flex items-center gap-2 px-3 py-2 border border-slate-200 text-slate-600 text-[12px] font-bold rounded-lg hover:bg-slate-50 transition-colors"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={pendingCodesLoading ? 'animate-spin' : ''}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                                    Refresh
                                </button>
                                {pendingCodes.some(r => r.suggestion.status === 'SUGGESTED' || r.suggestion.status === 'UNDER_REVIEW') && (
                                    <button
                                        onClick={handleAcceptAllPending}
                                        disabled={pendingAcceptingAll || pendingRestoringAll}
                                        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-[12px] font-extrabold rounded-lg shadow-sm transition-colors"
                                    >
                                        {pendingAcceptingAll ? (
                                            <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Accepting...</>
                                        ) : (
                                            <><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Accept Pending ({pendingCodes.filter(r => r.suggestion.status === 'SUGGESTED' || r.suggestion.status === 'UNDER_REVIEW').length})</>
                                        )}
                                    </button>
                                )}
                                {pendingCodes.some(r => r.suggestion.status === 'APPROVED' || r.suggestion.status === 'MODIFIED' || r.suggestion.status === 'REJECTED') && (
                                    <button
                                        onClick={handleRestoreAll}
                                        disabled={pendingRestoringAll || pendingAcceptingAll}
                                        className="flex items-center gap-2 px-4 py-2 border border-slate-300 hover:bg-slate-50 disabled:bg-slate-100 text-slate-700 text-[12px] font-extrabold rounded-lg shadow-sm transition-colors"
                                    >
                                        {pendingRestoringAll ? (
                                            <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Restoring...</>
                                        ) : (
                                            <><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Restore All</>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Table */}
                        <div className="flex-1 overflow-auto">
                            {pendingCodesLoading ? (
                                <div className="flex items-center justify-center h-full gap-3 text-slate-400">
                                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                    <span className="text-[13px] font-semibold">Loading pending codes...</span>
                                </div>
                            ) : pendingCodes.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                                    <div className="w-14 h-14 bg-emerald-50 rounded-2xl flex items-center justify-center">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500"><path d="M20 6 9 17l-5-5"/></svg>
                                    </div>
                                    <p className="font-bold text-slate-600">All caught up!</p>
                                    <p className="text-[12px] text-slate-400">No pending AI codes across your project.</p>
                                </div>
                            ) : (
                                <table className="w-full text-left border-collapse">
                                    <thead className="bg-white sticky top-0 z-10 shadow-sm border-b border-slate-200">
                                        <tr>
                                            <th className="px-6 py-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-[10%]">Transcript</th>
                                            <th className="px-4 py-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-[28%]">Excerpt</th>
                                            <th className="px-6 py-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-[18%]">AI Code</th>
                                            <th className="px-4 py-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-[10%]">
                                                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-purple-400 inline-block"/>Your Code</span>
                                            </th>
                                            <th className="px-4 py-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-[18%]">Rationale &amp; Memos</th>
                                            <th className="px-4 py-3 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-[16%] text-center">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {pendingCodes.map(row => {
                                            const conf = parseInt(row.suggestion.confidence || '0') || 0
                                            const confBg = conf >= 80 ? 'bg-emerald-100 text-emerald-700' : conf >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
                                            const humanLabel = row.humanCodes[0]
                                            const isAccepted = row.suggestion.status === 'APPROVED' || row.suggestion.status === 'MODIFIED'
                                            // For accepted AI suggestions, show the accepted label as "Your Code"
                                            const yourCodeLabel = humanLabel || (isAccepted ? row.suggestion.label : null)
                                            const isMatch = humanLabel && (row.suggestion.label.toLowerCase().includes(humanLabel.toLowerCase()) || humanLabel.toLowerCase().includes(row.suggestion.label.toLowerCase()))
                                            return (
                                                <tr key={row.segmentId} className="hover:bg-indigo-50/20 transition-colors bg-white group">
                                                    {/* 1. Transcript */}
                                                    <td className="px-4 py-4 align-top">
                                                        <a href={`/projects/${projectId}/transcripts/${row.transcriptId}?segment=${row.segmentId}`} target="_blank" className="text-[11px] font-bold text-indigo-600 hover:underline flex items-center gap-1" title="Jump to this highlight in the transcript">
                                                            {row.transcriptTitle}
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 0 2-2h6"/></svg>
                                                        </a>
                                                    </td>
                                                    
                                                    {/* 2. Excerpt */}
                                                    <td className="px-6 py-4 align-top">
                                                        <p className="text-[12px] text-slate-600 leading-relaxed italic line-clamp-3 group-hover:line-clamp-none transition-all">"{row.text}"</p>
                                                    </td>

                                                    {/* 3. AI Code */}
                                                    <td className="px-6 py-4 align-top">
                                                        {(() => {
                                                            const draftLabel = pendingLabelEdits[row.segmentId]
                                                            const displayLabel = draftLabel ?? row.suggestion.label
                                                            const isEdited = draftLabel !== undefined && draftLabel !== row.suggestion.label
                                                            return (
                                                            <div className="flex flex-col gap-2 items-start group/label relative">
                                                                {/* Editable label — always accessible, no separate save button */}
                                                                {(!isAccepted && !row.isHuman && row.suggestion.status !== 'REJECTED') ? (
                                                                    <div className="flex flex-col gap-1 w-full">
                                                                        <input
                                                                            type="text"
                                                                            value={displayLabel}
                                                                            onChange={e => setPendingLabelEdits(prev => ({ ...prev, [row.segmentId]: e.target.value }))}
                                                                            onKeyDown={e => {
                                                                                if (e.key === 'Escape') setPendingLabelEdits(prev => { const n = {...prev}; delete n[row.segmentId]; return n; })
                                                                            }}
                                                                            className={`text-[11px] font-bold px-2 py-1 border rounded w-full focus:outline-none focus:ring-1 focus:ring-indigo-400 ${isEdited ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-indigo-100 bg-indigo-50 text-indigo-700'}`}
                                                                            title="Edit code label — change takes effect on Accept"
                                                                        />
                                                                        {isEdited && (
                                                                            <div className="flex items-center gap-1">
                                                                                <span className="text-[8px] font-bold text-amber-600 uppercase tracking-wider">Edited — will override on Accept</span>
                                                                                <button onClick={() => setPendingLabelEdits(prev => { const n = {...prev}; delete n[row.segmentId]; return n; })} className="text-[8px] text-slate-400 hover:text-rose-500">↩ revert</button>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                ) : (
                                                                    <div className="flex items-start gap-1">
                                                                        <span className="inline-flex text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-1 rounded text-[11px] font-bold max-w-[200px] whitespace-normal">
                                                                            {row.suggestion.label}
                                                                        </span>
                                                                    </div>
                                                                )}
                                                                <div className="flex gap-1 items-center flex-wrap">
                                                                    {!row.isHuman && conf > 0 && <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded w-fit ${confBg}`}>{conf}%</span>}
                                                                    {row.isHuman && <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider bg-purple-100 text-purple-700 w-fit">HUMAN</span>}
                                                                </div>
                                                                {/* Assigned themes — persisted links already in DB */}
                                                                {((row.suggestion as any).assignedThemes as { id: string; name: string }[] | undefined)?.length ? (
                                                                    <div className="flex flex-col gap-0.5 mt-0.5">
                                                                        <span className="text-[8px] font-extrabold text-slate-400 uppercase tracking-widest">In theme:</span>
                                                                        <div className="flex flex-wrap gap-1">
                                                                            {((row.suggestion as any).assignedThemes as { id: string; name: string }[]).map(t => (
                                                                                <span
                                                                                    key={t.id}
                                                                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-teal-50 text-teal-700 border border-teal-200 rounded text-[9px] font-bold"
                                                                                    title={`Linked to theme: ${t.name}`}
                                                                                >
                                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                                                                    {t.name}
                                                                                </span>
                                                                            ))}
                                                                        </div>
                                                                    </div>
                                                                ) : null}
                                                                {/* Alternatives — clean dropdown */}
                                                                {!isAccepted && !row.isHuman && row.suggestion.status !== 'REJECTED' && Array.isArray((row.suggestion as any).alternatives) && (row.suggestion as any).alternatives.length > 0 && (
                                                                    <div className="flex items-center gap-1.5 mt-0.5">
                                                                        <span className="text-[9px] text-slate-400 font-semibold shrink-0">Try instead:</span>
                                                                        <select
                                                                            value=""
                                                                            onChange={e => {
                                                                                if (e.target.value) {
                                                                                    setPendingLabelEdits(prev => ({ ...prev, [row.segmentId]: e.target.value }))
                                                                                }
                                                                            }}
                                                                            className="text-[10px] text-slate-600 border border-slate-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 cursor-pointer flex-1 min-w-0"
                                                                        >
                                                                            <option value="">Select alternative...</option>
                                                                            {((row.suggestion as any).alternatives as string[]).map((alt: string, altIdx: number) => {
                                                                                const tagMatch = alt.match(/^\[([^\]]+)\]\s*/);
                                                                                const tag = tagMatch ? tagMatch[1] : null;
                                                                                const cleanAlt = tagMatch ? alt.slice(tagMatch[0].length) : alt;
                                                                                return (
                                                                                    <option key={altIdx} value={cleanAlt}>
                                                                                        {tag ? `[${tag}] ${cleanAlt}` : cleanAlt}
                                                                                    </option>
                                                                                )
                                                                            })}
                                                                        </select>
                                                                    </div>
                                                                )}
                                                                {/* Theme — on-demand AI button */}
                                                                {!isAccepted && !row.isHuman && row.suggestion.status !== 'REJECTED' && (() => {
                                                                    const rowSel = rowThemeSelections[row.segmentId];
                                                                    const suggestions = rowThemeSuggestions[row.segmentId];
                                                                    const isLoading = rowThemeSuggestingLoading[row.segmentId];
                                                                    return (
                                                                        <div className="flex flex-col gap-1 w-full pt-1.5 border-t border-slate-100 mt-0.5">
                                                                            <div className="flex items-center justify-between">
                                                                                <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest">Theme</span>
                                                                                {rowSel?.label && (
                                                                                    <button
                                                                                        onClick={() => { setRowThemeSelections(prev => { const n = {...prev}; delete n[row.segmentId]; return n; }); setRowThemeSuggestions(prev => { const n = {...prev}; delete n[row.segmentId]; return n; }); }}
                                                                                        className="text-[8px] text-slate-300 hover:text-rose-400 transition-colors"
                                                                                    >✕ clear</button>
                                                                                )}
                                                                            </div>
                                                                            {/* Selected theme chip */}
                                                                            {rowSel?.label && (
                                                                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${rowSel.themeId ? 'bg-teal-50 text-teal-700 border-teal-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                                                                    {rowSel.themeId ? '✓' : '+'} {rowSel.label}
                                                                                </span>
                                                                            )}
                                                                            {/* Suggestions list */}
                                                                            {suggestions && suggestions.length > 0 && (
                                                                                <div className="flex flex-col gap-0.5">
                                                                                    {suggestions.map((s, si) => (
                                                                                        <button
                                                                                            key={si}
                                                                                            onClick={() => setRowThemeSelections(prev => ({ ...prev, [row.segmentId]: { themeId: s.themeId || undefined, newThemeName: s.themeId ? undefined : s.label, label: s.label } }))}
                                                                                            title={s.reasoning}
                                                                                            className={`text-left px-2 py-1 rounded border text-[10px] font-semibold transition-colors ${rowSel?.label === s.label ? 'ring-1 ring-indigo-400' : ''} ${s.isExisting ? 'bg-teal-50 text-teal-700 border-teal-100 hover:bg-teal-100' : 'bg-slate-50 text-slate-600 border-slate-100 hover:bg-slate-100'}`}
                                                                                        >
                                                                                            <span className="text-[8px] font-extrabold uppercase opacity-50 mr-1">{s.isExisting ? 'existing' : 'new'}</span>
                                                                                            {s.label}
                                                                                        </button>
                                                                                    ))}
                                                                                    {/* Custom input */}
                                                                                    <input
                                                                                        type="text"
                                                                                        placeholder="Or type custom theme..."
                                                                                        onKeyDown={e => {
                                                                                            if (e.key === 'Enter') {
                                                                                                const val = (e.target as HTMLInputElement).value.trim();
                                                                                                if (val) setRowThemeSelections(prev => ({ ...prev, [row.segmentId]: { newThemeName: val, label: val } }));
                                                                                                (e.target as HTMLInputElement).value = '';
                                                                                            }
                                                                                        }}
                                                                                        className="mt-0.5 px-2 py-0.5 text-[10px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-300 text-slate-600"
                                                                                    />
                                                                                </div>
                                                                            )}
                                                                            {/* Trigger button */}
                                                                            {!suggestions && (
                                                                                <button
                                                                                    onClick={() => handleSuggestThemes(row)}
                                                                                    disabled={isLoading}
                                                                                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-600 text-[10px] font-bold hover:bg-indigo-100 transition-colors disabled:opacity-50"
                                                                                >
                                                                                    {isLoading ? (
                                                                                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                                                                    ) : (
                                                                                        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M22 2 12 12"/><path d="m17 2 5 5-5 5"/></svg>
                                                                                    )}
                                                                                    {isLoading ? 'Thinking...' : '✦ Suggest Theme'}
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    )
                                                                })()}
                                                            </div>
                                                            )
                                                        })()}
                                                    </td>

                                                    {/* 4. Your Code */}
                                                    <td className="px-4 py-4 align-top">
                                                        {(() => {
                                                            // Case 1: Human-only segment (no AI suggestions at all)
                                                            if (row.isHuman) {
                                                                return (
                                                                    <div className="flex flex-col gap-1.5">
                                                                        <span className="inline-flex text-purple-700 bg-purple-50 border border-purple-100 px-2 py-1 rounded text-[11px] font-bold max-w-[130px] whitespace-normal">{humanLabel}</span>
                                                                        <span className="text-[9px] text-purple-400 font-semibold">Human coded only</span>
                                                                    </div>
                                                                )
                                                            }
                                                            // Case 2: Both Human + AI, codes align
                                                            if (humanLabel && isMatch) {
                                                                return (
                                                                    <div className="flex flex-col gap-1.5">
                                                                        <span className="inline-flex text-purple-700 bg-purple-50 border border-purple-100 px-2 py-1 rounded text-[11px] font-bold max-w-[130px] whitespace-normal">{humanLabel}</span>
                                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold text-emerald-600">
                                                                            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                                                            Codes align
                                                                        </span>
                                                                    </div>
                                                                )
                                                            }
                                                            // Case 3: Both Human + AI, codes differ
                                                            if (humanLabel && !isMatch) {
                                                                return (
                                                                    <div className="flex flex-col gap-1.5">
                                                                        <span className="inline-flex text-purple-700 bg-purple-50 border border-purple-100 px-2 py-1 rounded text-[11px] font-bold max-w-[130px] whitespace-normal">{humanLabel}</span>
                                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold text-amber-600">
                                                                            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>
                                                                            Codes differ
                                                                        </span>
                                                                    </div>
                                                                )
                                                            }
                                                            // Case 4: Human accepted the AI suggestion
                                                            if (!humanLabel && isAccepted) {
                                                                return (
                                                                    <div className="flex flex-col gap-1.5">
                                                                        <span className="inline-flex text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded text-[11px] font-bold max-w-[130px] whitespace-normal">{row.suggestion.label}</span>
                                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold text-emerald-500">
                                                                            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                                                            Human accepted AI
                                                                        </span>
                                                                    </div>
                                                                )
                                                            }
                                                            // Case 5: AI only, human hasn't coded this yet
                                                            return (
                                                                <div className="flex flex-col gap-1">
                                                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-slate-50 border border-slate-200 px-2 py-1 rounded">
                                                                        Not yet coded
                                                                    </span>
                                                                    <span className="text-[9px] text-slate-400 font-medium">AI only suggestion</span>
                                                                </div>
                                                            )
                                                        })()}
                                                    </td>

                                                    {/* 5. Rationale & Memos */}
                                                    <td className="px-4 py-4 align-top">
                                                        <div className="flex flex-col gap-2">
                                                            {/* AI Explanation */}
                                                            {(row.suggestion as any).explanation && (
                                                                <p className="text-[11px] text-slate-600 leading-relaxed font-medium">
                                                                    {(row.suggestion as any).explanation}
                                                                </p>
                                                            )}
                                                            {/* AI Reliance Report (expandable) */}
                                                            {(row.suggestion as any).uncertainty && (row.suggestion as any).uncertainty !== 'None' && (() => {
                                                                const isExpanded = (expandedRationaleRows as any)[row.segmentId];
                                                                let reportContent = null;
                                                                try {
                                                                    const data = JSON.parse((row.suggestion as any).uncertainty);
                                                                    if (data.finalScore !== undefined) {
                                                                        const semSimPct = Math.round((parseFloat(data.semanticSimilarity || '0.85')) * 100);
                                                                        const selfAssRaw = data.selfAssessmentGrade || '4.0';
                                                                        const totalRuns = parseInt(data.totalRuns || '3', 10);
                                                                        const consistencyMatch = (data.runConsistency || '').match(/(\d+)\/(\d+)/);
                                                                        const agrees = consistencyMatch ? parseInt(consistencyMatch[1], 10) : totalRuns;
                                                                        reportContent = (
                                                                            <div className="flex flex-col gap-1 mt-1 text-[10px] text-slate-500">
                                                                                <div className="flex justify-between"><span>Contextual Resonance</span><span className="font-bold">{semSimPct}%</span></div>
                                                                                <div className="flex justify-between"><span>Reasoning Stability</span><span className="font-bold">{agrees}/{totalRuns}</span></div>
                                                                                <div className="flex justify-between"><span>Critic Grade</span><span className="font-bold">{selfAssRaw}/5.0</span></div>
                                                                            </div>
                                                                        );
                                                                    }
                                                                } catch { /* skip */ }
                                                                if (!reportContent) return null;
                                                                return (
                                                                    <div className="mt-1 bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] shadow-sm">
                                                                        <button
                                                                            onClick={() => setExpandedRationaleRows((p: any) => ({ ...p, [row.segmentId]: !p[row.segmentId] }))}
                                                                            className="flex items-center justify-between w-full uppercase tracking-widest text-[9px] font-extrabold text-slate-400 hover:text-slate-700 transition-colors"
                                                                        >
                                                                            <span className="flex items-center gap-1">
                                                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                                                                                AI Reliance Report
                                                                            </span>
                                                                            <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/></svg>
                                                                        </button>
                                                                        {isExpanded && <div className="pt-1.5 mt-1.5 border-t border-slate-200">{reportContent}</div>}
                                                                    </div>
                                                                );
                                                            })()}
                                                            {/* Researcher memo */}
                                                            {(row.suggestion as any).reviewDecision?.note && (
                                                                <div className="bg-purple-50 border border-purple-100 rounded-lg p-2 mt-1">
                                                                    <strong className="flex items-center gap-1 uppercase tracking-widest text-[8px] mb-1 font-extrabold text-purple-600">
                                                                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                                                                        Researcher Memo
                                                                    </strong>
                                                                    <p className="text-[10px] text-purple-900 leading-relaxed italic">"{(row.suggestion as any).reviewDecision.note}"</p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </td>

                                                    {/* 6. Actions */}
                                                    <td className="px-4 py-4 align-top">
                                                        {row.isHuman ? (
                                                            <div className="flex justify-center">
                                                                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-50 text-emerald-600 text-[9px] font-extrabold uppercase tracking-widest border border-emerald-200">
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                                                    ACCEPTED
                                                                </span>
                                                            </div>
                                                        ) : row.suggestion.status === 'APPROVED' || row.suggestion.status === 'MODIFIED' ? (
                                                            <div className="flex flex-col items-center gap-2">
                                                                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-50 text-emerald-600 text-[9px] font-extrabold uppercase tracking-widest border border-emerald-200">
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                                                    ACCEPTED
                                                                </span>
                                                                <div className="flex items-center justify-center gap-2">
                                                                    <button onClick={() => handleCompareDecision(row, 'RESTORE')} className="text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition">Restore</button>
                                                                    <span className="text-slate-200 text-[10px]">|</span>
                                                                    <button onClick={() => handleCompareDecision(row, 'REJECT')} className="text-[10px] font-bold text-rose-400 hover:text-rose-600 transition">Revoke</button>
                                                                </div>
                                                            </div>
                                                        ) : row.suggestion.status === 'REJECTED' ? (
                                                            <div className="flex flex-col items-center gap-2">
                                                                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-rose-50 text-rose-600 text-[9px] font-extrabold uppercase tracking-widest border border-rose-200">
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                                                    REJECTED
                                                                </span>
                                                                <button onClick={() => handleCompareDecision(row, 'RESTORE')} className="text-[10px] font-bold text-indigo-500 hover:underline">Undo</button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex flex-col gap-2 max-w-[120px] mx-auto">
                                                                <button onClick={() => handleCompareDecision(row, 'ACCEPT')} className="w-full py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded text-[11px] font-bold transition-colors shadow-sm">Accept</button>
                                                                <button onClick={() => handleCompareDecision(row, 'REJECT')} className="w-full py-1.5 bg-white border border-rose-200 hover:bg-rose-50 text-rose-600 rounded text-[11px] font-bold transition-colors shadow-sm">Reject</button>
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                )}

                {/* Analyze Relationships Tab */}
                {activeTab === 'Analyze Relationships' && (
                    <div className="absolute inset-0 z-10 flex overflow-hidden">
                        <ThematicMatrixView
                            themes={themes}
                            assignedCount={assignedCount}
                        />
                    </div>
                )}

                {/* Builder Layout — fills the space, hidden when not on Build Themes */}
                <div className={`absolute inset-0 flex overflow-hidden ${activeTab !== 'Build Themes' ? 'invisible pointer-events-none' : ''}`}>
                    {/* Left Panel: collapsed icon */}
                    {!isLeftPanelOpen && activeTab === 'Build Themes' && (
                        <div className="w-12 border-r border-slate-200 bg-slate-50 flex flex-col items-center py-4 flex-shrink-0 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => setIsLeftPanelOpen(true)} title="Expand codes panel">
                            <div className="flex flex-col items-center gap-2 mt-16">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                                <div className="[writing-mode:vertical-rl] rotate-180 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{unassignedCodes.length} Codes</div>
                            </div>
                        </div>
                    )}
                    {/* Left Panel: Unassigned Codes */}
                    {isLeftPanelOpen && activeTab === 'Build Themes' && (
                    <div 
                        className="w-[220px] lg:w-[300px] border-r border-slate-200 bg-slate-50/50 flex flex-col flex-shrink-0"
                        onDragOver={handleDragOver}
                        onDrop={handleDropToRoot}
                    >
                        <div className="p-4 border-b border-slate-200/50 flex items-center justify-between bg-white">
                            <h2 className="text-sm font-extrabold flex items-center gap-2 text-slate-800">
                                <button onClick={() => setIsLeftPanelOpen(false)} title="Collapse panel" className="text-slate-400 hover:text-slate-600 p-0.5 rounded hover:bg-slate-100 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                                </button>
                                Unassigned Codes
                            </h2>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setShowObsPanel(true)}
                                    title="Add an observation code not tied to a specific quote"
                                    className="flex items-center gap-1 text-[10px] font-bold text-violet-600 bg-violet-50 border border-violet-200 hover:bg-violet-100 px-2 py-1 rounded-lg transition-colors"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                                    Observation
                                </button>
                                <span className="text-xs font-bold text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-full shadow-sm">
                                    {unassignedCodes.length}
                                </span>
                            </div>
                        </div>



                        {/* Search bar for unassigned codes */}
                        <div className="px-3 py-2 border-b border-slate-200/50 bg-white">
                            <div className="relative">
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
                                </svg>
                                <input
                                    type="text"
                                    placeholder="Search codes..."
                                    value={unassignedSearch}
                                    onChange={e => setUnassignedSearch(e.target.value)}
                                    className="w-full pl-7 pr-7 py-1.5 text-[11px] font-medium bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 transition-all"
                                />
                                {unassignedSearch && (
                                    <button onClick={() => setUnassignedSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="p-4 flex-1 overflow-y-auto custom-scrollbar space-y-3">
                            {!unassignedSearch && <p className="text-xs text-slate-400 mb-4 font-medium">Drag codes to themes on the right</p>}
                            
                            {loading ? (
                                <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                                    <svg className="w-6 h-6 animate-spin mb-3" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    <span className="text-xs font-medium">Loading codes...</span>
                                </div>
                            ) : unassignedCodes.length === 0 ? (
                                <div className="text-center py-12">
                                    <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>
                                    </div>
                                    <p className="text-xs font-semibold text-slate-500 mb-1">No unassigned codes</p>
                                    <p className="text-[11px] text-slate-400">All codes have been assigned to themes, or no codes exist yet. Run AI analysis on transcripts first.</p>
                                </div>
                            ) : (() => {
                                const filteredCodes = unassignedSearch
                                    ? unassignedCodes.filter(c => c.name.toLowerCase().includes(unassignedSearch.toLowerCase()))
                                    : unassignedCodes
                                if (filteredCodes.length === 0) return (
                                    <div className="text-center py-8">
                                        <p className="text-[11px] font-semibold text-slate-400">No codes match "{unassignedSearch}"</p>
                                    </div>
                                )
                                return filteredCodes.map(code => (
                                        <div 
                                            key={code.id}
                                            draggable
                                            onDragStart={(e) => handleDragStart(e, { codeId: code.id })}
                                            onDragEnd={handleDragEnd}
                                            className={`bg-white border rounded-xl p-3 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing group ${
                                                code.type === 'OBSERVATION'
                                                    ? 'border-violet-200 hover:border-violet-400'
                                                    : 'border-slate-200 hover:border-indigo-300'
                                            }`}
                                        >
                                            <div className="flex items-start justify-between mb-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1 mb-1.5">
                                                        {code.type === 'OBSERVATION' && (
                                                            <span className="inline-flex items-center gap-1 text-[9px] font-extrabold text-violet-600 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                                                                Observation
                                                            </span>
                                                        )}
                                                        {code.type === 'AI-ASSISTED' && (
                                                            <span className="inline-flex items-center gap-1 text-[9px] font-extrabold text-indigo-600 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275z"/></svg>
                                                                AI Suggested
                                                            </span>
                                                        )}
                                                        {code.type === 'MANUAL' && (
                                                            <span className="inline-flex items-center gap-1 text-[9px] font-extrabold text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                                                Human Created
                                                            </span>
                                                        )}
                                                    </div>
                                                    <h3 className="text-[13px] font-bold text-slate-800 leading-snug pr-4">{code.name}</h3>
                                                </div>
                                                <button 
                                                    onClick={() => setCodeToDelete({ id: code.id, name: code.name })}
                                                    className="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                                                    title="Remove code"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                                </button>
                                            </div>
                                            <div className="flex flex-col gap-2">
                                                {code.type === 'OBSERVATION' ? (
                                                    <div className="flex flex-col gap-1.5">
                                                        {code.memo && (
                                                            <div className="flex flex-wrap items-center gap-1.5">
                                                                <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border border-violet-200 text-violet-700 bg-violet-50" title="Context">
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>
                                                                    {code.memo}
                                                                </span>
                                                            </div>
                                                        )}
                                                        {code.definition ? (
                                                            <p className="text-[10px] text-violet-600 italic leading-relaxed line-clamp-2">{code.definition}</p>
                                                        ) : (
                                                            <p className="text-[10px] text-slate-300 italic">No reflexive note yet</p>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="flex flex-col gap-2">
                                                        {code.definition && (
                                                            <div className="bg-slate-50 border border-slate-100 rounded p-2">
                                                                <p className="text-[9px] text-slate-500 italic leading-relaxed line-clamp-2" title={code.definition}>
                                                                    {code.definition.includes('[Researcher Note]') ? code.definition.split('[Researcher Note]')[1].replace(':', '').trim() : code.definition}
                                                                </p>
                                                            </div>
                                                        )}
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex flex-wrap items-center gap-1.5">
                                                                {code.participants?.map(p => (
                                                                    <span key={p.id} className={`flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${getParticipantColor(p.name)}`} title={`From transcript: ${p.name}`}>
                                                                        <span className="w-1 h-1 rounded-full bg-current opacity-75"></span>
                                                                        {p.name.length > 10 ? p.name.substring(0, 10) + '...' : p.name}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                            <span className="text-[10px] font-medium text-slate-400 whitespace-nowrap ml-2">{code.instances} instances</span>
                                                        </div>
                                                    </div>
                                                )}
                                                {code.type !== 'OBSERVATION' && (
                                                    <div className="flex items-center justify-end mt-1">
                                                        <button 
                                                            onClick={() => openTrace(code.id, code.name)} 
                                                            className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                                                            title="View original quotes"
                                                        >
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/></svg>
                                                            Trace
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))
                            })()}
                        </div>
                    </div>
                    )}

                    {/* Center Panel: Canvas */}
                    <div className="flex-1 min-w-0 relative overflow-hidden" style={{height:'100%'}}>
                        {/* Undo Merge toast — floats above canvas */}
                        {lastMergedThemeId && (
                            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 w-auto">
                                <div className="flex items-center justify-between gap-4 bg-emerald-50 border border-emerald-300 rounded-xl px-4 py-3 shadow-lg">
                                    <div className="flex items-center gap-2.5">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500 flex-shrink-0"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                                        <p className="text-[12px] font-bold text-emerald-800 whitespace-nowrap">Themes merged successfully.</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={handleUndoMerge} disabled={undoingMerge} className="flex items-center gap-1.5 bg-white border border-emerald-400 text-emerald-700 text-[11px] font-bold px-3 py-1.5 rounded-lg hover:bg-emerald-100 transition-colors shadow-sm disabled:opacity-50">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                                            {undoingMerge ? 'Undoing...' : 'Undo Merge'}
                                        </button>
                                        <button onClick={() => setLastMergedThemeId(null)} className="text-emerald-400 hover:text-emerald-600 p-1 rounded-lg hover:bg-emerald-100 transition-colors">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Canvas hint when empty */}
                        {themes.length === 0 && themeSuggestions.length === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                                <div className="text-center">
                                    <div className="w-16 h-16 bg-white border-2 border-dashed border-slate-200 rounded-2xl flex items-center justify-center mx-auto mb-5 text-slate-300 shadow-sm">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                                    </div>
                                    <h2 className="text-xl font-extrabold text-slate-700 tracking-tight mb-2">Ready to cluster {unassignedCodes.length} codes?</h2>
                                    <p className="text-slate-400 text-sm max-w-xs mx-auto leading-relaxed mb-6">Double-click anywhere on the canvas, or use the button below.</p>
                                    <button
                                        className="pointer-events-auto bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl text-sm font-bold shadow-lg hover:shadow-indigo-200 hover:-translate-y-0.5 transition-all inline-flex items-center gap-2"
                                        onClick={() => handleCanvasCreateTheme('Untitled Theme', 100, 100)}
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                                        Create your first theme
                                    </button>
                                </div>
                            </div>
                        )}

                        <ThemeCanvas
                            themes={themes as any}
                            projectId={projectId}
                            draggingCodeId={draggingType === 'code' ? (draggingCodeId ?? null) : null}
                            draggingFromThemeId={draggingFromThemeId ?? null}
                            onDropCode={handleCanvasDropCode}
                            onDropOnCanvas={handleCanvasDropOnEmpty}
                            onEdit={(id, name, desc) => setNewThemeModal({ open: true, id, name, description: desc })}
                            onDelete={deleteTheme}
                            onRemoveCode={handleCanvasRemoveCode}
                            onPositionSave={handleCanvasPositionSave}
                            onCreateTheme={handleCanvasCreateTheme}
                            onDragStartCode={(codeId, themeId) => {
                                setDraggingType('code')
                                setDraggingCodeId(codeId)
                                setDraggingFromThemeId(themeId)
                            }}
                            onDragEndCode={() => {
                                setDraggingType(null)
                                setDraggingCodeId(null)
                                setDraggingFromThemeId(null)
                            }}
                            aiSuggestions={themeSuggestions}
                            onAcceptSuggestion={acceptSuggestion}
                            onRejectSuggestion={rejectSuggestion}
                            onAcceptAllSuggestions={acceptAllSuggestions}
                            acceptingAllSuggestions={acceptingAllSuggestions}
                            onDismissAllSuggestions={() => {
                                setThemeSuggestions([])
                                clearSuggestionsCache()
                                resetSuggestions()
                            }}
                            suggestionsLoading={suggestionsLoading}
                            suggestionsRemainingAfterBatch={suggestionsRemainingAfterBatch}
                            onLoadNextBatch={() => generateSuggestions(false, suggestionBatchOffset)}
                        />
                    </div>
                </div>

                {/* Codebook Tab */}
                {activeTab === 'Codebook' && (
                    <div className="absolute inset-0 bg-white z-20 flex flex-col overflow-hidden">
                        <div className="flex-shrink-0 px-6 py-3 border-b border-slate-200 flex items-center justify-between">
                            <div>
                                <h2 className="text-base font-extrabold text-slate-800">Codebook</h2>
                                <p className="text-[11px] text-slate-400">Click a code to view or add its definition. Hover a row for actions.</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold bg-slate-100 text-slate-500 px-3 py-1 rounded-full">{themes.length} themes · {assignedCount} codes</span>
                                <button
                                    onClick={() => exportCodebookCSV(themes, `codebook_${projectId}.csv`)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm"
                                    title="Export codebook to CSV (opens in Excel, Numbers, Google Sheets)"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                                    Export CSV
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {themes.length === 0 ? (
                                <div className="flex items-center justify-center h-full">
                                    <p className="text-sm font-bold text-slate-300">No themes yet — create some in Builder</p>
                                </div>
                            ) : (
                                <div className="border-b border-slate-200">
                                    <table className="w-full text-left text-sm text-slate-600">
                                        <thead className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                                            <tr className="bg-slate-50">
                                                <th className="px-5 py-3 border-b border-r border-slate-200 w-[18%] text-[10px] font-bold uppercase tracking-wide text-slate-400">Theme</th>
                                                <th className="px-5 py-3 border-b border-r border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400">Code · Definition</th>
                                                <th className="px-5 py-3 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400">Sample Excerpt</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {themes.flatMap((theme) =>
                                                theme.codeLinks && theme.codeLinks.length > 0 ? theme.codeLinks.map((link, lIdx) => (
                                                    <CodebookRow
                                                        key={`${theme.id}-${link.codebookEntry.id}`}
                                                        theme={theme}
                                                        link={link}
                                                        isFirstInTheme={lIdx === 0}
                                                        themeRowSpan={theme.codeLinks.length}
                                                        onTrace={(codeId, codeName) => openTrace(codeId, codeName)}
                                                        projectId={projectId}
                                                        onUpdate={fetchData}
                                                    />
                                                )) : [
                                                    <tr key={`empty-${theme.id}`}>
                                                        <ThemeCell theme={theme} rowSpan={1} projectId={projectId} onUpdate={fetchData} />
                                                        <td colSpan={2} className="px-5 py-4 border-b border-slate-100 text-[12px] italic text-slate-300">No codes assigned yet</td>
                                                    </tr>
                                                ]
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </div>
                )}
                </div>
            </div>



            {/* Synthesize Themes Modal */}
            {synthModalOpen && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                            <div>
                                <h2 className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-violet-600"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>
                                    Synthesize Themes
                                </h2>
                                <p className="text-xs font-semibold text-slate-500 mt-0.5">Merging narrow sub-themes into overarching meta-themes</p>
                            </div>
                            <button 
                                onClick={() => setSynthModalOpen(false)}
                                className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 bg-white border border-slate-200 rounded-full shadow-sm hover:bg-slate-50"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/30">
                            {synthLoading ? (
                                <div className="flex flex-col items-center justify-center py-20 text-indigo-400">
                                    <svg className="w-10 h-10 animate-spin mb-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                    <p className="text-sm font-bold text-slate-500 animate-pulse">Analyzing connections to build overarching themes...</p>
                                </div>
                            ) : synthSuggestions.length === 0 ? (
                                <div className="text-center py-10 text-slate-400 text-sm font-bold">No meaningful groupings found.</div>
                            ) : (
                                <div className="space-y-6">
                                    {synthSuggestions.map((s, idx) => (
                                        <div key={idx} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                                            <div className="flex justify-between items-start mb-3">
                                                <div>
                                                    <h3 className="text-sm font-extrabold text-indigo-700 mb-1">{s.name}</h3>
                                                    <p className="text-xs text-slate-600 leading-relaxed font-medium max-w-2xl">{s.description}</p>
                                                </div>
                                                <button
                                                    onClick={() => acceptSynth(idx)}
                                                    disabled={synthAcceptingId === idx}
                                                    className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-[11px] font-bold shadow-sm hover:bg-indigo-700 transition-colors disabled:opacity-50 flex-shrink-0 flex items-center gap-1.5"
                                                >
                                                    {synthAcceptingId === idx ? "Merging..." : "Merge These Themes"}
                                                </button>
                                            </div>
                                            <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 mt-4">
                                                <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400 mb-2">Will merge {s.matchedThemes?.length} child themes:</p>
                                                <div className="flex flex-wrap gap-2">
                                                    {s.matchedThemes?.map((t: any) => (
                                                        <span key={t.id} className="bg-white border border-slate-200 text-slate-700 text-[11px] font-semibold px-2.5 py-1 rounded-md shadow-sm flex items-center gap-1">
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                                                            {t.name}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* New Theme Modal */}
            {newThemeModal.open && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
                        {/* Modal header */}
                        <div className="px-6 py-5 border-b border-slate-100 bg-slate-50">
                            <div className="flex items-center gap-3 mb-0.5">
                                <div className="w-8 h-8 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center flex-shrink-0">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
                                </div>
                                <div>
                                    <h3 className="text-[15px] font-extrabold text-slate-800">
                                        {newThemeModal.id ? 'Edit Theme' : 'Create New Theme'}
                                    </h3>
                                    <p className="text-[11px] text-slate-500">
                                        A Theme groups related codes together. Drag codes from the left panel.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-widest mb-1.5">
                                    Theme Name
                                </label>
                                <input
                                    type="text"
                                    autoFocus
                                    value={newThemeModal.name}
                                    onChange={e => setNewThemeModal({ ...newThemeModal, name: e.target.value })}
                                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveTheme() }}
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                                    placeholder="e.g. Navigation & Wayfinding"
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-widest mb-1.5">Description (Optional)</label>
                                <textarea
                                    value={newThemeModal.description}
                                    onChange={e => setNewThemeModal({ ...newThemeModal, description: e.target.value })}
                                    className="w-full h-24 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-medium text-slate-600"
                                    placeholder="What does this theme represent? Explain the central concept..."
                                />
                            </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 px-6 pb-6">
                            <button onClick={() => setNewThemeModal({ open: false, id: undefined, name: '', description: '' })} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={saveTheme}
                                className="text-white bg-slate-800 hover:bg-slate-900 px-5 py-2 rounded-lg text-sm font-bold shadow-sm transition-colors"
                            >
                                {newThemeModal.id ? 'Save Changes' : 'Create Theme'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Trace Quotes Modal */}
            {tracingCode && (
                <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
                    <div className="bg-white w-full max-w-2xl max-h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                            <div>
                                <h2 className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-500"><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/></svg>
                                    Code Tracing: {tracingCode.name}
                                </h2>
                                <p className="text-xs font-semibold text-slate-500 mt-0.5">Original quotes assigned to this code</p>
                            </div>
                            <button 
                                onClick={() => setTracingCode(null)}
                                className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 bg-white border border-slate-200 rounded-full shadow-sm hover:bg-slate-50"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </div>
                        
                        {/* Content area */}
                        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/30">
                            {tracingLoading ? (
                                <div className="flex flex-col items-center justify-center py-16 text-indigo-400">
                                    <svg className="w-8 h-8 animate-spin mb-4" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    <span className="text-sm font-bold text-indigo-600">Retrieving quotes from transcripts...</span>
                                </div>
                            ) : tracingQuotes.length === 0 ? (
                                <div className="text-center py-12 text-slate-400">
                                    <p className="text-sm font-semibold">No quotes found for this code.</p>
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    {tracingQuotes.map((tq: any) => (
                                        <div key={tq.transcriptId} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                            <div className="bg-slate-100 px-4 py-2 border-b border-slate-200 flex items-center justify-between">
                                                <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5 uppercase tracking-wide">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                                                    {tq.transcriptName}
                                                </h3>
                                                <span className="text-[10px] font-bold text-slate-400">{tq.quotes.length} highlights</span>
                                            </div>
                                            <div className="divide-y divide-slate-100">
                                                {tq.quotes.map((q: any) => (
                                                    <div key={q.segmentId} className="p-4 hover:bg-slate-50/80 transition-colors group">
                                                        <p className="text-[13px] leading-relaxed text-slate-700 italic border-l-2 border-indigo-200 pl-3">"{q.text}"</p>
                                                        <div className="mt-3 flex items-center justify-between">
                                                            <div>
                                                                {q.confidence && (
                                                                    <span className="text-[9px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider bg-slate-100 text-slate-500">
                                                                        AI Conf: {q.confidence}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <button 
                                                                onClick={() => {
                                                                    router.push(`/projects/${tq.projectId}/transcripts/${tq.transcriptId}?segment=${q.segmentId}`)
                                                                }}
                                                                className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-1 rounded shadow-sm hover:bg-indigo-100 hover:text-indigo-800 transition-all flex items-center gap-1"
                                                            >
                                                                Go to source
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Observation Code Creation Panel ── */}
            {showObsPanel && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowObsPanel(false)}>
                    <div
                        className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-slate-200"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-violet-50">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-xl bg-violet-100 border border-violet-200 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                                </div>
                                <div>
                                    <h3 className="text-[14px] font-extrabold text-violet-900">New Observation Code</h3>
                                    <p className="text-[10px] text-violet-500 font-medium">Capture latent meanings not tied to a specific quote</p>
                                </div>
                            </div>
                            <button onClick={() => setShowObsPanel(false)} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </div>

                        {/* Form */}
                        <div className="p-6 space-y-4">
                            {/* Code Label */}
                            <div>
                                <label className="block text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-1.5">
                                    Code Label <span className="text-rose-400">*</span>
                                </label>
                                <input
                                    type="text"
                                    autoFocus
                                    value={obsForm.label}
                                    onChange={e => setObsForm(f => ({ ...f, label: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter' && obsForm.label.trim()) createObservationCode() }}
                                    placeholder="E.g., Nervous body language, Unspoken grief…"
                                    className="w-full text-[13px] font-medium border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent text-slate-800 placeholder:text-slate-300 bg-slate-50 focus:bg-white transition-colors"
                                />
                            </div>

                            {/* Reflexive Note */}
                            <div>
                                <label className="block text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-1.5">
                                    Reflexive Note <span className="font-normal text-slate-300 normal-case">(optional)</span>
                                </label>
                                <textarea
                                    value={obsForm.note}
                                    onChange={e => setObsForm(f => ({ ...f, note: e.target.value }))}
                                    placeholder="Why are you coding this? What evidence — verbal, non-verbal, or contextual — supports this observation?"
                                    rows={3}
                                    className="w-full text-[12px] font-medium border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent text-slate-700 placeholder:text-slate-300 bg-slate-50 focus:bg-white transition-colors resize-none leading-relaxed"
                                />
                                <p className="text-[9px] text-slate-400 mt-1 px-1">📌 Saved to the Codebook definition. Supports reflexivity in your research write-up.</p>
                            </div>

                            {/* Context */}
                            <div>
                                <label className="block text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-1.5">
                                    Context — Participant / Setting <span className="font-normal text-slate-300 normal-case">(optional)</span>
                                </label>
                                <input
                                    type="text"
                                    value={obsForm.context}
                                    onChange={e => setObsForm(f => ({ ...f, context: e.target.value }))}
                                    placeholder="E.g., P1 and P3, interview room, phone call…"
                                    className="w-full text-[12px] font-medium border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent text-slate-700 placeholder:text-slate-300 bg-slate-50 focus:bg-white transition-colors"
                                />
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
                            <p className="text-[10px] text-slate-400 italic max-w-[220px] leading-relaxed">This code will appear in Unassigned Codes and can be dragged into any theme.</p>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowObsPanel(false)}
                                    className="px-4 py-2 text-[12px] font-semibold text-slate-500 hover:text-slate-700 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={createObservationCode}
                                    disabled={!obsForm.label.trim() || obsSaving}
                                    className="px-5 py-2 bg-violet-600 text-white text-[12px] font-bold rounded-xl hover:bg-violet-700 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                                >
                                    {obsSaving ? (
                                        <><svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Saving…</>
                                    ) : (
                                        <><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg> Create Code</>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* General Delete Confirmation */}
            <ConfirmModal
                isOpen={codeToDelete !== null}
                title="Remove Code"
                message={`Are you sure you want to remove the code "${codeToDelete?.name}"?\n\nThis will remove the Codebook Entry. Any original quotes will go back to 'Pending AI Review' status.`}
                confirmText="Remove"
                isDestructive={true}
                onConfirm={async () => {
                    if (codeToDelete) {
                        await fetch(`/api/codebook/${codeToDelete.id}`, { method: 'DELETE' })
                        setCodeToDelete(null)
                        fetchData()
                    }
                }}
                onCancel={() => setCodeToDelete(null)}
            />
            <ConfirmModal
                isOpen={themeToDelete !== null}
                title="Delete Theme"
                message={`Delete theme "${themeToDelete?.name}"?\n\nAll code assignments within this theme will be removed.`}
                confirmText="Delete"
                isDestructive={true}
                onConfirm={async () => {
                    if (themeToDelete) {
                        await fetch(`/api/projects/${projectId}/themes/${themeToDelete.id}`, { method: 'DELETE' })
                        setThemeToDelete(null)
                        await fetchData()
                        // Codes returned to unassigned — old suggestions are stale, reset to fresh state
                        resetSuggestions()
                    }
                }}
                onCancel={() => setThemeToDelete(null)}
            />
        </div>
    )
}
