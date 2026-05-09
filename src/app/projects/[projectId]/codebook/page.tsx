'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'

type CodeEntry = {
    id: string
    name: string
    type: string
    definition?: string | null
    examplesIn?: string
    _count?: { codeAssignments: number }
    participants?: { id: string; name: string }[]
    sampleQuotes?: { segmentId: string; text: string; participantName: string; transcriptId: string }[]
}

type ThemeData = {
    id: string
    name: string
    description: string | null
    status: string
    isMeta?: boolean
    parentId?: string | null
    children?: ThemeData[]
    participantsCount?: number
    piecesCount?: number
    codeLinks: { codebookEntry: CodeEntry }[]
}

// CSV is now generated server-side via /api/projects/[projectId]/codebook/export

export default function CodebookPage() {
    const params = useParams()
    const router = useRouter()
    const projectId = params.projectId as string
    const [themes, setThemes] = useState<ThemeData[]>([])
    const [loading, setLoading] = useState(true)

    // Inline edit state
    const [editingThemeDesc, setEditingThemeDesc] = useState<string | null>(null) // themeId
    const [themeDescDraft, setThemeDescDraft] = useState('')
    const [editingCodeDef, setEditingCodeDef] = useState<string | null>(null) // codeId
    const [codeDefDraft, setCodeDefDraft] = useState('')
    const [savingTheme, setSavingTheme] = useState(false)
    const [savingCode, setSavingCode] = useState(false)

    // Trace panel state
    const [tracingCode, setTracingCode] = useState<{ id: string; name: string } | null>(null)
    const [tracingQuotes, setTracingQuotes] = useState<any[]>([])
    const [tracingLoading, setTracingLoading] = useState(false)

    const fetchThemes = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/projects/${projectId}/themes`)
            const data = await res.json()
            
            // Merge identical codes within each theme (by name)
            const mergedData = Array.isArray(data) ? data.map((t: any) => {
                const uniqueLinksMap = new Map();
                for (const link of t.codeLinks || []) {
                    const name = link.codebookEntry.name.trim().toLowerCase();
                    if (!uniqueLinksMap.has(name)) {
                        // Deep clone to avoid mutating original
                        uniqueLinksMap.set(name, JSON.parse(JSON.stringify(link)));
                    } else {
                        const existing = uniqueLinksMap.get(name);
                        // Merge sample quotes
                        const existingQuotes = existing.codebookEntry.sampleQuotes || [];
                        for (const q of (link.codebookEntry.sampleQuotes || [])) {
                            if (!existingQuotes.some((eq: any) => eq.text === q.text)) {
                                existingQuotes.push(q);
                            }
                        }
                        existing.codebookEntry.sampleQuotes = existingQuotes;
                        
                        // Merge participants
                        const existingPax = existing.codebookEntry.participants || [];
                        for (const p of (link.codebookEntry.participants || [])) {
                            if (!existingPax.some((ep: any) => ep.id === p.id)) {
                                existingPax.push(p);
                            }
                        }
                        existing.codebookEntry.participants = existingPax;

                        // Merge assignment counts
                        if (!existing.codebookEntry._count) existing.codebookEntry._count = { codeAssignments: 0 };
                        existing.codebookEntry._count.codeAssignments += (link.codebookEntry._count?.codeAssignments || 0);
                    }
                }
                return { ...t, codeLinks: Array.from(uniqueLinksMap.values()) };
            }) : [];

            setThemes(mergedData)
        } catch (e) {
            console.error(e)
        } finally { setLoading(false) }
    }, [projectId])

    useEffect(() => { fetchThemes() }, [fetchThemes])

    // Only count top-level themes for display
    const topLevelThemes = themes.filter(t => !t.parentId)
    const assignedCount = themes.reduce((acc, t) => acc + (t.codeLinks?.length || 0), 0)
    const totalParticipants = new Set(
        themes.flatMap(t => t.codeLinks.flatMap(l => (l.codebookEntry.participants || []).map(p => p.id)))
    ).size

    // Save theme description
    const saveThemeDesc = async (themeId: string) => {
        setSavingTheme(true)
        try {
            await fetch(`/api/projects/${projectId}/themes/${themeId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: themeDescDraft })
            })
            await fetchThemes() // Ensure data is perfectly in sync
        } catch (e) { 
            console.error(e)
        } finally {
            setSavingTheme(false)
            setEditingThemeDesc(null)
        }
    }

    // Save code explanation
    const saveCodeDef = async (codeId: string) => {
        setSavingCode(true)
        try {
            await fetch(`/api/codebook/${codeId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ definition: codeDefDraft })
            })
            await fetchThemes() // Ensure data is perfectly in sync
        } catch (e) {
            console.error(e)
        } finally {
            setSavingCode(false)
            setEditingCodeDef(null)
        }
    }

    // Open trace panel
    const openTrace = async (codeId: string, codeName: string) => {
        setTracingCode({ id: codeId, name: codeName })
        setTracingLoading(true)
        setTracingQuotes([])
        try {
            const res = await fetch(`/api/codebook/${codeId}/quotes`)
            if (res.ok) setTracingQuotes(await res.json())
        } catch { } finally { setTracingLoading(false) }
    }

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Header */}
            <header className="px-8 py-5 border-b border-slate-200 flex items-center justify-between bg-white flex-shrink-0">
                <div>
                    <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900">④ Codebook</h1>
                    <p className="text-sm text-slate-500 mt-0.5 font-medium">
                        All codes organized by theme — edit definitions and trace back to source evidence
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-[11px] font-bold bg-slate-100 text-slate-500 px-3 py-1.5 rounded-full">
                        {topLevelThemes.length} themes · {assignedCount} codes · {totalParticipants} participants
                    </span>
                    <a
                        href={`/api/projects/${projectId}/codebook/export`}
                        download="codebook.csv"
                        className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl text-[12px] font-bold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm no-underline"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                        Export CSV
                    </a>
                </div>
            </header>

            {/* Body */}
            <main className="flex-1 overflow-auto">
                {loading ? (
                    <div className="flex items-center justify-center h-full text-slate-400">
                        <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        Loading codebook...
                    </div>
                ) : themes.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center max-w-sm">
                            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                            </div>
                            <p className="font-bold text-slate-500 mb-1">No themes yet</p>
                            <p className="text-sm text-slate-400">Create themes in <strong>③ Theme Builder</strong> first.</p>
                        </div>
                    </div>
                ) : (
                    <table className="w-full text-left text-sm text-slate-600">
                        <thead className="bg-slate-50 sticky top-0 z-10 border-b border-slate-200">
                            <tr>
                                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 w-[14%] border-r border-slate-200">Mega Theme</th>
                                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 w-[14%] border-r border-slate-200">Theme</th>
                                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 border-r border-slate-200 w-[14%]">Code</th>
                                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 border-r border-slate-200 w-[24%]">Explanation</th>
                                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 border-r border-slate-200 w-[24%]">Sample Evidence</th>
                                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 w-[10%]">Participant IDs</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topLevelThemes.flatMap((themeOrMega) => {
                                const renderMegaThemeInfo = (t: any) => (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-extrabold text-fuchsia-700 text-[13px]">{t.name}</span>
                                        </div>
                                    </div>
                                )
                                // Shared cell content for Themes
                                const renderThemeInfo = (t: any) => (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-bold text-slate-800 text-[13px]">{t.name}</span>
                                        </div>
                                        <div className="flex gap-2 flex-wrap">
                                            <span className="text-[10px] font-semibold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{t.participantsCount ?? 0} participants</span>
                                        </div>
                                        <div className="mt-1">
                                            {editingThemeDesc === t.id ? (
                                                <div className="space-y-1.5">
                                                    <textarea autoFocus className="w-full text-[11px] text-slate-700 border border-indigo-300 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300" rows={3} value={themeDescDraft} onChange={e => setThemeDescDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditingThemeDesc(null) }} placeholder="Add description..." />
                                                    <div className="flex gap-1">
                                                        <button onClick={() => saveThemeDesc(t.id)} disabled={savingTheme} className="text-[10px] font-bold px-2 py-0.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">{savingTheme ? '...' : 'Save'}</button>
                                                        <button onClick={() => setEditingThemeDesc(null)} className="text-[10px] font-bold px-2 py-0.5 bg-slate-100 text-slate-600 rounded-md">Cancel</button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <button onClick={() => { setEditingThemeDesc(t.id); setThemeDescDraft(t.description || '') }} className="group/desc w-full text-left">
                                                    {t.description
                                                        ? <p className="text-[11px] text-slate-500 italic leading-relaxed group-hover/desc:text-slate-700 transition-colors">{t.description}</p>
                                                        : <p className="text-[11px] text-slate-300 italic group-hover/desc:text-indigo-400 transition-colors flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Add description</p>
                                                    }
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )

                                // Render code cells block (Code...Participant IDs)
                                const renderCodeCells = (link: any) => (
                                    <>
                                        {/* Code name */}
                                        <td className="px-5 py-4 border-r border-slate-100 align-top bg-white"><div className="font-bold text-slate-800 text-[12px] leading-snug">{link.codebookEntry.name}</div></td>
                                        {/* Explanation */}
                                        <td className="px-5 py-4 border-r border-slate-100 align-top bg-white">
                                            {editingCodeDef === link.codebookEntry.id ? (
                                                <div className="space-y-1.5">
                                                    <textarea autoFocus className="w-full text-[11px] text-slate-700 border border-indigo-300 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300" rows={3} value={codeDefDraft} onChange={e => setCodeDefDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditingCodeDef(null) }} placeholder="Add explanation..." />
                                                    <div className="flex gap-1">
                                                        <button onClick={() => saveCodeDef(link.codebookEntry.id)} disabled={savingCode} className="text-[10px] font-bold px-2 py-0.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">{savingCode ? '...' : 'Save'}</button>
                                                        <button onClick={() => setEditingCodeDef(null)} className="text-[10px] font-bold px-2 py-0.5 bg-slate-100 text-slate-600 rounded-md">Cancel</button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <button onClick={() => { setEditingCodeDef(link.codebookEntry.id); setCodeDefDraft(link.codebookEntry.definition || '') }} className="group/def w-full text-left">
                                                    {link.codebookEntry.definition ? (
                                                        <p className="text-[11px] text-slate-500 leading-relaxed group-hover/def:text-slate-700 transition-colors">{link.codebookEntry.definition}</p>
                                                    ) : link.codebookEntry.examplesIn && link.codebookEntry.type !== 'OBSERVATION' ? (
                                                        <div>
                                                            <span className="inline-block text-[8px] font-extrabold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full uppercase tracking-widest mb-1">Inclusion criteria</span>
                                                            <p className="text-[11px] text-slate-400 italic leading-relaxed group-hover/def:text-slate-600 transition-colors">{link.codebookEntry.examplesIn}</p>
                                                            <p className="text-[9px] text-indigo-400 mt-1 group-hover/def:text-indigo-600 transition-colors">+ Click to add explanation</p>
                                                        </div>
                                                    ) : (
                                                        <p className="text-[11px] text-slate-300 italic group-hover/def:text-indigo-400 transition-colors flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Add explanation</p>
                                                    )}
                                                </button>
                                            )}
                                        </td>
                                        {/* Evidence */}
                                        <td className="px-5 py-4 border-r border-slate-100 align-top bg-white">
                                            {link.codebookEntry.sampleQuotes && link.codebookEntry.sampleQuotes.length > 0 ? (
                                                <div>
                                                    <p onClick={() => { const q = link.codebookEntry.sampleQuotes![0]; router.push(`/projects/${projectId}/transcripts/${q.transcriptId}?segment=${q.segmentId}`) }} className="text-[11px] text-slate-500 italic leading-relaxed line-clamp-3 cursor-pointer hover:text-slate-700 transition-colors">"{link.codebookEntry.sampleQuotes[0].text}"</p>
                                                    <div className="flex items-center justify-between mt-1.5 gap-1">
                                                        <span className="text-[10px] font-semibold text-violet-500 bg-violet-50 border border-violet-100 px-1.5 py-0.5 rounded-full truncate max-w-[120px]">{link.codebookEntry.sampleQuotes[0].participantName}</span>
                                                        <button onClick={() => openTrace(link.codebookEntry.id, link.codebookEntry.name)} className="flex-shrink-0 text-[10px] text-slate-400 hover:text-indigo-600 font-semibold transition-colors whitespace-nowrap">{(link.codebookEntry._count?.codeAssignments ?? 0) > 1 ? `+${(link.codebookEntry._count?.codeAssignments ?? 1) - 1} →` : 'View →'}</button>
                                                    </div>
                                                </div>
                                            ) : <p className="text-[11px] text-slate-300 italic">—</p>}
                                        </td>
                                        {/* Participant IDs */}
                                        <td className="px-5 py-4 align-top bg-white">
                                            {link.codebookEntry.participants && link.codebookEntry.participants.length > 0 ? (
                                                <div className="flex flex-wrap gap-1">
                                                    {link.codebookEntry.participants.slice(0, 4).map((p: any) => <span key={p.id} className="text-[9px] font-semibold text-violet-600 bg-violet-50 border border-violet-100 px-1.5 py-0.5 rounded-full whitespace-nowrap">{p.name}</span>)}
                                                    {link.codebookEntry.participants.length > 4 && <span className="text-[9px] font-semibold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">+{link.codebookEntry.participants.length - 4}</span>}
                                                </div>
                                            ) : <p className="text-[11px] text-slate-300 italic">—</p>}
                                        </td>
                                    </>
                                )

                                // Mega Theme handling
                                if (themeOrMega.isMeta || (themeOrMega.children && themeOrMega.children.length > 0)) {
                                    const children = themeOrMega.children || [];
                                    const allChildLinks = children.flatMap((child: any) => 
                                        (child.codeLinks || []).map((l: any) => ({ ...l, childTheme: child }))
                                    );
                                    if (allChildLinks.length === 0) return null;

                                    return allChildLinks.map((linkWithTheme: any, idx: number) => {
                                        const isFirstMega = idx === 0;
                                        const childLinkIndex = linkWithTheme.childTheme.codeLinks.findIndex((l: any) => l.codebookEntry.id === linkWithTheme.codebookEntry.id);
                                        const isFirstChild = childLinkIndex === 0;

                                        return (
                                            <tr key={`${themeOrMega.id}-${linkWithTheme.codebookEntry.id}`} className="border-b border-slate-100 hover:bg-slate-50/40 transition-colors">
                                                {isFirstMega && (
                                                    <td rowSpan={allChildLinks.length} className="px-5 py-4 border-r border-fuchsia-100 align-top bg-fuchsia-50/30">
                                                        {renderMegaThemeInfo(themeOrMega)}
                                                    </td>
                                                )}
                                                {isFirstChild && (
                                                    <td rowSpan={linkWithTheme.childTheme.codeLinks.length} className="px-5 py-4 border-r border-slate-100 align-top bg-slate-50/30">
                                                        {renderThemeInfo(linkWithTheme.childTheme)}
                                                    </td>
                                                )}
                                                {renderCodeCells(linkWithTheme)}
                                            </tr>
                                        )
                                    })
                                } else {
                                    // Regular theme
                                    if (!themeOrMega.codeLinks || themeOrMega.codeLinks.length === 0) return null
                                    return themeOrMega.codeLinks.map((link: any, linkIdx: number) => (
                                        <tr key={`${themeOrMega.id}-${link.codebookEntry.id}`} className="border-b border-slate-100 hover:bg-slate-50/40 transition-colors">
                                            {linkIdx === 0 && (
                                                <td rowSpan={themeOrMega.codeLinks.length} className="px-5 py-4 border-r border-slate-100 align-top bg-slate-50/10">
                                                    <span className="text-[10px] text-slate-400 italic">—</span>
                                                </td>
                                            )}
                                            {linkIdx === 0 && (
                                                <td rowSpan={themeOrMega.codeLinks.length} className="px-5 py-4 border-r border-slate-100 align-top bg-slate-50/30">
                                                    {renderThemeInfo(themeOrMega)}
                                                </td>
                                            )}
                                            {renderCodeCells(link)}
                                        </tr>
                                    ))
                                }
                            })}
                        </tbody>
                    </table>
                )}
            </main>

            {/* Trace Side Panel */}
            {tracingCode && (
                <div className="fixed inset-0 z-50 flex" onClick={() => setTracingCode(null)}>
                    <div className="flex-1 bg-black/20 backdrop-blur-sm" />
                    <div className="w-[440px] bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-indigo-50">
                            <div>
                                <h3 className="text-sm font-extrabold text-indigo-900">{tracingCode.name}</h3>
                                <p className="text-xs text-indigo-400 mt-0.5">Source evidence for this code</p>
                            </div>
                            <button onClick={() => setTracingCode(null)} className="text-indigo-300 hover:text-indigo-600 p-1.5 rounded-lg hover:bg-indigo-100 transition-colors">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            {tracingLoading ? (
                                <div className="flex items-center justify-center py-12 text-slate-400">
                                    <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                    Loading quotes...
                                </div>
                            ) : tracingQuotes.length === 0 ? (
                                <p className="text-sm text-slate-400 text-center py-12">No quotes found for this code.</p>
                            ) : tracingQuotes.map((group: any, gi: number) => (
                                <div key={gi} className="space-y-3">
                                    {/* Transcript group header */}
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-extrabold text-slate-500 uppercase tracking-widest">{group.transcriptName}</span>
                                        <button
                                            onClick={() => router.push(`/projects/${projectId}/transcripts/${group.transcriptId}${group.quotes[0]?.segmentId ? `?segment=${group.quotes[0].segmentId}` : ''}`)}
                                            className="text-[10px] font-bold text-indigo-500 hover:text-indigo-700 flex items-center gap-1 bg-indigo-50 px-2 py-0.5 rounded-lg"
                                        >
                                            Open
                                            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                                        </button>
                                    </div>
                                    {group.quotes.map((q: any, qi: number) => (
                                        <div key={qi} className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                                            <p className="text-[13px] text-slate-700 italic leading-relaxed">"{q.text}"</p>
                                            <div className="flex items-center justify-between mt-2">
                                                {q.confidence && (
                                                    <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-md ${
                                                        q.confidence === 'HIGH' ? 'bg-emerald-50 text-emerald-600' :
                                                        q.confidence === 'MEDIUM' ? 'bg-amber-50 text-amber-600' :
                                                        'bg-slate-100 text-slate-400'
                                                    }`}>
                                                        {q.confidence} confidence
                                                    </span>
                                                )}
                                                {q.segmentId && (
                                                    <button
                                                        onClick={() => router.push(`/projects/${projectId}/transcripts/${group.transcriptId}?segment=${q.segmentId}`)}
                                                        className="text-[10px] font-bold text-indigo-500 hover:text-indigo-700 flex items-center gap-0.5 ml-auto"
                                                    >
                                                        Go to source
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
