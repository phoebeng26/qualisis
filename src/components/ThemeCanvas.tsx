'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    Node,
    NodeProps,
    Handle,
    Position,
    ReactFlowProvider,
    useReactFlow,
    Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

// ─── Types ────────────────────────────────────────────────────────────────────
type CodeLink = {
    codebookEntry: {
        id: string
        name: string
        type: string
        _count: { codeAssignments: number }
        participants?: { id: string; name: string }[]
    }
}

export type ThemeNodeData = {
    id: string
    name: string
    description: string | null
    memo: string | null
    status: string
    codeLinks: CodeLink[]
    participantsCount?: number
    onEdit: (id: string, name: string, description: string) => void
    onDelete: (id: string, name: string) => void
    onRemoveCode: (themeId: string, codeId: string) => void
    onDropCode: (themeId: string, codeId: string, fromThemeId?: string) => void
    onDragStartCode: (codeId: string, themeId: string) => void
    onDragEndCode: () => void
    draggingCodeId: string | null
    draggingFromThemeId: string | null
}

// ─── Theme Card Node ──────────────────────────────────────────────────────────
function ThemeNode({ data, selected }: NodeProps) {
    const d = data as ThemeNodeData
    const [isDragOver, setIsDragOver] = useState(false)
    const [expanded, setExpanded] = useState(false)

    const codesArr = d.codeLinks || []
    const codesToShow = expanded ? codesArr : codesArr.slice(0, 4)
    const hiddenCount = codesArr.length - 4
    const isDropTarget = d.draggingCodeId !== null

    return (
        <div
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }}
            onDragLeave={e => { e.stopPropagation(); setIsDragOver(false) }}
            onDrop={e => {
                e.preventDefault()
                e.stopPropagation()
                setIsDragOver(false)
                let payload: { codeId?: string; fromThemeId?: string } = {}
                try { payload = JSON.parse(e.dataTransfer.getData('application/json')) } catch {}
                if (payload.codeId) {
                    d.onDropCode(d.id, payload.codeId, payload.fromThemeId)
                }
            }}
            className={`w-[320px] rounded-2xl border transition-all shadow-sm bg-white flex flex-col relative
                ${isDragOver ? 'border-indigo-500 shadow-lg shadow-indigo-100 bg-indigo-50/30' : ''}
                ${isDropTarget && !isDragOver ? 'border-indigo-300 border-dashed' : ''}
                ${!isDropTarget && !isDragOver ? 'border-slate-200/80 hover:border-slate-300 hover:shadow-md' : ''}
                ${selected ? 'ring-2 ring-indigo-500 ring-offset-1' : ''}
            `}
            style={{ cursor: 'default' }}
        >
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-slate-300 rounded-l-2xl" />

            {isDragOver && (
                <div className="absolute inset-0 rounded-2xl pointer-events-none z-10 flex items-end justify-center pb-3">
                    <span className="bg-indigo-600 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg shadow flex items-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                        Drop to add code
                    </span>
                </div>
            )}

            <div className="p-4 flex flex-col gap-2.5">
                <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-extrabold text-slate-800 leading-snug break-words flex-1">{d.name}</p>
                    <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
                        <button className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors" title="Edit theme" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); d.onEdit(d.id, d.name, d.description || '') }}>
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                        </button>
                        <button className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-md transition-colors" title="Delete theme" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); d.onDelete(d.id, d.name) }}>
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>

                {d.description && <p className="text-[11px] text-slate-500 leading-relaxed break-words">{d.description}</p>}

                <div className="flex flex-col gap-1 min-h-[28px] p-2 -mx-1 bg-slate-50/60 rounded-xl border border-dashed border-slate-200">
                    {codesArr.length === 0 && <p className="text-[10px] text-slate-400 italic text-center py-1">Drop codes here</p>}
                    {codesToShow.map(link => (
                        <span
                            key={link.codebookEntry.id}
                            draggable
                            onDragStart={e => {
                                e.stopPropagation()
                                d.onDragStartCode(link.codebookEntry.id, d.id)
                                e.dataTransfer.setData('application/json', JSON.stringify({
                                    codeId: link.codebookEntry.id,
                                    fromThemeId: d.id
                                }))
                                e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragEnd={e => {
                                e.stopPropagation()
                                d.onDragEndCode()
                            }}
                            className={`nodrag flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold group/chip cursor-grab active:cursor-grabbing ${link.codebookEntry.type === 'OBSERVATION' ? 'bg-violet-50 text-violet-700 border border-violet-100' : 'bg-white text-slate-700 border border-slate-200 hover:border-indigo-300'}`}
                        >
                            <span className="truncate">{link.codebookEntry.name}</span>
                            <button className="opacity-0 group-hover/chip:opacity-100 text-slate-300 hover:text-rose-500 transition-all flex-shrink-0" title="Remove code" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); d.onRemoveCode(d.id, link.codebookEntry.id) }}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            </button>
                        </span>
                    ))}
                    {hiddenCount > 0 && !expanded && <button className="text-[10px] text-indigo-500 font-bold text-center hover:text-indigo-700 py-0.5" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpanded(true) }}>+{hiddenCount} more</button>}
                    {expanded && codesArr.length > 4 && <button className="text-[10px] text-slate-400 font-bold text-center hover:text-slate-600 py-0.5" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpanded(false) }}>Show less</button>}
                </div>

                <div className="flex items-center justify-between pt-0.5">
                    <span className="text-[10px] text-slate-400 font-medium">{codesArr.length} codes</span>
                    <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        {d.participantsCount || 0}
                    </div>
                </div>
            </div>

            <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
        </div>
    )
}

// ─── Suggested Theme Card Node (Ghost Node) ───────────────────────────────────
export type SuggestedThemeNodeData = {
    name: string
    description: string
    reason?: string
    confidenceScore?: number
    codes: { id: string; name: string; type: string }[]
    onAccept: (name: string) => void
    onReject: (name: string) => void
}

function SuggestedThemeNode({ data, selected }: NodeProps) {
    const d = data as SuggestedThemeNodeData
    const [expanded, setExpanded] = useState(false)

    const codesToShow = expanded ? d.codes : d.codes.slice(0, 4)
    const hiddenCount = d.codes.length - 4

    return (
        <div
            className={`w-[320px] rounded-2xl border-2 border-dashed transition-all shadow-lg flex flex-col relative
                bg-indigo-50/80 border-indigo-300 backdrop-blur-sm
                ${selected ? 'ring-4 ring-indigo-500/20 ring-offset-2 border-indigo-400' : 'hover:border-indigo-400'}
            `}
            style={{ cursor: 'default' }}
        >
            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-indigo-400 to-violet-400 rounded-l-2xl" />

            <div className="p-4 flex flex-col gap-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1 flex-1">
                        <div className="flex items-center gap-1.5">
                            <svg className="text-indigo-500" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                            <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Suggested</span>
                            {d.confidenceScore && (
                                <span className="text-[10px] font-bold text-indigo-400 bg-white/60 px-1.5 py-0.5 rounded-md ml-auto">
                                    {Math.round(d.confidenceScore)}% Match
                                </span>
                            )}
                        </div>
                        <p className="text-sm font-extrabold text-indigo-950 leading-snug break-words">{d.name}</p>
                    </div>
                </div>

                {/* Description & Reason */}
                <div className="flex flex-col gap-1.5">
                    <p className="text-[11px] text-indigo-800/80 leading-relaxed break-words">{d.description}</p>
                    {d.reason && (
                        <div className="bg-white/50 rounded-lg p-2 mt-1 border border-indigo-100/50">
                            <p className="text-[10px] font-semibold text-indigo-500 mb-0.5">Why this group?</p>
                            <p className="text-[10px] text-indigo-700 leading-relaxed italic">{d.reason}</p>
                        </div>
                    )}
                </div>

                {/* Code chips */}
                <div className="flex flex-col gap-1 min-h-[28px] p-2 -mx-1 bg-white/40 rounded-xl border border-white/60">
                    {codesToShow.map(code => (
                        <span key={code.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold bg-white/80 text-indigo-900 border border-indigo-100 shadow-sm">
                            <span className="truncate">{code.name}</span>
                        </span>
                    ))}
                    {hiddenCount > 0 && !expanded && <button className="text-[10px] text-indigo-600 font-bold text-center hover:text-indigo-800 py-0.5" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpanded(true) }}>+{hiddenCount} more</button>}
                    {expanded && d.codes.length > 4 && <button className="text-[10px] text-indigo-400 font-bold text-center hover:text-indigo-600 py-0.5" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpanded(false) }}>Show less</button>}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2">
                    <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); d.onAccept(d.name) }}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 rounded-xl transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-1.5"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        Accept Theme
                    </button>
                    <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); d.onReject(d.name) }}
                        className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-white hover:bg-rose-50 text-slate-400 hover:text-rose-500 text-xs font-bold rounded-xl transition-all shadow-sm border border-slate-200 hover:border-rose-200"
                        title="Reject Suggestion"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>
            </div>

            <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
        </div>
    )
}

const nodeTypes = { themeCard: ThemeNode, suggestedThemeCard: SuggestedThemeNode }

// ─── Floating create form (screen-space overlay, not a flow node) ─────────────
interface FloatingCreateFormProps {
    screenX: number
    screenY: number
    onConfirm: (name: string) => void
    onCancel: () => void
}
function FloatingCreateForm({ screenX, screenY, onConfirm, onCancel }: FloatingCreateFormProps) {
    const [name, setName] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)
    useEffect(() => { inputRef.current?.focus() }, [])

    const submit = () => onConfirm(name.trim() || 'Untitled Theme')

    return (
        <div
            className="absolute z-50 pointer-events-auto"
            style={{ left: screenX, top: screenY, transform: 'translate(-50%, -50%)' }}
        >
            <div className="bg-white border-2 border-indigo-500 rounded-2xl shadow-2xl shadow-indigo-200 p-4 w-72 flex flex-col gap-3 animate-in fade-in zoom-in-95 duration-150">
                <p className="text-[11px] font-extrabold text-indigo-700 uppercase tracking-wide">New Theme</p>
                <input
                    ref={inputRef}
                    placeholder="Name your theme… (optional)"
                    className="w-full bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2.5 text-sm font-semibold text-indigo-900 placeholder:text-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') submit()
                        if (e.key === 'Escape') onCancel()
                    }}
                />
                <div className="flex gap-2">
                    <button onClick={submit} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold py-2 rounded-xl transition-colors shadow-sm">
                        Create
                    </button>
                    <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors">
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─── Inner Canvas ─────────────────────────────────────────────────────────────
interface ThemeCanvasInnerProps {
    themes: ThemeNodeData[]
    projectId: string
    draggingCodeId: string | null
    draggingFromThemeId: string | null
    onDropCode: (themeId: string, codeId: string, fromThemeId?: string) => void
    onDropOnCanvas: (codeId: string, x: number, y: number, fromThemeId?: string) => void
    onEdit: (id: string, name: string, description: string) => void
    onDelete: (id: string, name: string) => void
    onRemoveCode: (themeId: string, codeId: string) => void
    onPositionSave: (themeId: string, x: number, y: number) => void
    onCreateTheme: (name: string, x: number, y: number) => void
    onDragStartCode: (codeId: string, themeId: string) => void
    onDragEndCode: () => void
    aiSuggestions?: any[]
    onAcceptSuggestion?: (name: string) => void
    onRejectSuggestion?: (name: string) => void
    onAcceptAllSuggestions?: () => void
    acceptingAllSuggestions?: boolean
    onDismissAllSuggestions?: () => void
    suggestionsLoading?: boolean
    suggestionsRemainingAfterBatch?: number
    onLoadNextBatch?: () => void
}

function ThemeCanvasInner({
    themes, draggingCodeId, draggingFromThemeId,
    onDropCode, onDropOnCanvas, onEdit, onDelete, onRemoveCode, onPositionSave, onCreateTheme,
    onDragStartCode, onDragEndCode, aiSuggestions = [], onAcceptSuggestion, onRejectSuggestion, onAcceptAllSuggestions, acceptingAllSuggestions,
    onDismissAllSuggestions, suggestionsLoading = false, suggestionsRemainingAfterBatch = 0, onLoadNextBatch
}: ThemeCanvasInnerProps) {
    const { screenToFlowPosition } = useReactFlow()
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    // Pending creation: screen coords + flow coords
    const [pendingCreate, setPendingCreate] = useState<{ sx: number; sy: number; fx: number; fy: number } | null>(null)

    const makeNodes = useCallback((ts: ThemeNodeData[], suggs: any[]): Node[] => {
        const regularNodes: Node[] = ts.map((theme, i) => ({
            id: theme.id,
            type: 'themeCard',
            position: {
                x: (theme as any).positionX ?? (i % 4) * 380 + 40,
                y: (theme as any).positionY ?? Math.floor(i / 4) * 380 + 40,
            },
            data: { ...theme, onEdit, onDelete, onRemoveCode, onDropCode, onDragStartCode, onDragEndCode, draggingCodeId, draggingFromThemeId },
        }))

        const maxExistingY = ts.reduce((max, t, i) => Math.max(max, (t as any).positionY ?? (Math.floor(i / 4) * 380 + 40)), -400)
        const startY = ts.length > 0 ? maxExistingY + 440 : 40;

        const suggNodes: Node[] = suggs.map((sugg, i) => ({
            id: `suggestion-${sugg.name}`,
            type: 'suggestedThemeCard',
            position: {
                x: (i % 3) * 380 + 100,
                y: Math.floor(i / 3) * 380 + startY,
            },
            data: {
                ...sugg,
                onAccept: (name: string) => onAcceptSuggestion?.(name),
                onReject: (name: string) => onRejectSuggestion?.(name),
            }
        }))

        return [...regularNodes, ...suggNodes]
    }, [onEdit, onDelete, onRemoveCode, onDropCode, onDragStartCode, onDragEndCode, draggingCodeId, draggingFromThemeId, onAcceptSuggestion, onRejectSuggestion])

    const [nodes, setNodes, onNodesChange] = useNodesState(makeNodes(themes, aiSuggestions))
    const [edges, , onEdgesChange] = useEdgesState([])

    useEffect(() => {
        setNodes(prev => {
            const newNodes = makeNodes(themes, aiSuggestions)
            return newNodes.map(n => {
                const existing = prev.find(p => p.id === n.id)
                return existing ? { ...n, position: existing.position } : n
            })
        })
    }, [themes, aiSuggestions, makeNodes, setNodes])

    useEffect(() => {
        setNodes(prev => prev.map(n => ({ ...n, data: { ...n.data, draggingCodeId, draggingFromThemeId } })))
    }, [draggingCodeId, draggingFromThemeId, setNodes])

    const handleNodeDragStop = useCallback((_: any, node: Node) => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => onPositionSave(node.id, node.position.x, node.position.y), 600)
    }, [onPositionSave])

    const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }, [])

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        // Read directly from dataTransfer — more reliable than React state during async drag
        let payload: { codeId?: string; fromThemeId?: string } = {}
        try { payload = JSON.parse(e.dataTransfer.getData('application/json')) } catch { return }
        if (!payload.codeId) return

        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        onDropOnCanvas(payload.codeId, flowPos.x, flowPos.y, payload.fromThemeId)
    }, [screenToFlowPosition, onDropOnCanvas])

    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
        const target = e.target as HTMLElement
        const isBackground = target.classList.contains('react-flow__pane') || !!target.closest('.react-flow__background')
        if (!isBackground) return

        const containerRect = containerRef.current?.getBoundingClientRect()
        const sx = containerRect ? e.clientX - containerRect.left : e.clientX
        const sy = containerRect ? e.clientY - containerRect.top : e.clientY
        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })

        setPendingCreate({ sx, sy, fx: flowPos.x, fy: flowPos.y })
    }, [screenToFlowPosition])

    const handleCreateConfirm = useCallback((name: string) => {
        if (!pendingCreate) return
        onCreateTheme(name, pendingCreate.fx, pendingCreate.fy)
        setPendingCreate(null)
    }, [pendingCreate, onCreateTheme])

    return (
        <div ref={containerRef} className="w-full h-full relative">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={handleNodeDragStop}
                nodeTypes={nodeTypes}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDoubleClick={handleDoubleClick}
                minZoom={0.2}
                maxZoom={2}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                proOptions={{ hideAttribution: true }}
                className="bg-slate-50/50"
            >
                <Background color="#e2e8f0" gap={24} size={1} />
                <Controls className="!shadow-sm !border !border-slate-200 !rounded-xl overflow-hidden" showInteractive={false} />
                <MiniMap nodeColor="#6366f1" maskColor="rgba(241,245,249,0.7)" className="!rounded-xl !border !border-slate-200 !shadow-sm" />

                {/* AI Suggestions Control Panel */}
                {(suggestionsLoading || suggestionsRemainingAfterBatch > 0 || (aiSuggestions && aiSuggestions.length > 0)) && (
                    <Panel position="bottom-center" className="mb-4">
                        <div className="bg-white/95 backdrop-blur-md border border-indigo-200 shadow-xl rounded-2xl p-4 flex items-center gap-4 animate-in slide-in-from-bottom-4">
                            {suggestionsLoading ? (
                                <div className="flex items-center gap-3">
                                    <svg className="w-5 h-5 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    <span className="text-sm font-bold text-indigo-700">Analyzing code patterns...</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-sm font-extrabold text-slate-800">{aiSuggestions?.length || 0} Suggestions Ready</span>
                                            <span className="text-[11px] font-medium text-slate-500">Review on the canvas</span>
                                        </div>
                                    </div>
                                    <div className="w-px h-8 bg-slate-200"></div>
                                    <button
                                        onClick={onAcceptAllSuggestions}
                                        disabled={acceptingAllSuggestions}
                                        className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-[12px] font-bold px-4 py-2 rounded-xl transition-all shadow-sm flex items-center gap-1.5"
                                        title="Accept all suggestions at once"
                                    >
                                        {acceptingAllSuggestions ? (
                                            <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Accepting...</>
                                        ) : (
                                            <><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Accept All</>
                                        )}
                                    </button>
                                    {suggestionsRemainingAfterBatch > 0 && (
                                        <>
                                            <div className="w-px h-8 bg-slate-200"></div>
                                            <button
                                                onClick={onLoadNextBatch}
                                                className="bg-indigo-600 hover:bg-indigo-700 text-white text-[12px] font-bold px-4 py-2 rounded-xl transition-all shadow-sm"
                                            >
                                                Analyze next {Math.min(80, suggestionsRemainingAfterBatch)} codes
                                            </button>
                                        </>
                                    )}
                                    <div className="w-px h-8 bg-slate-200"></div>
                                    <button
                                        onClick={onDismissAllSuggestions}
                                        className="text-slate-400 hover:text-rose-500 text-[12px] font-bold px-3 py-2 rounded-xl hover:bg-rose-50 transition-all flex items-center gap-1.5"
                                        title="Dismiss all AI suggestions"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                        Dismiss All
                                    </button>
                                </div>
                            )}
                        </div>
                    </Panel>
                )}

                {/* Hint in bottom-left */}
                <Panel position="bottom-left">
                    <p className="text-[11px] text-slate-400 font-medium bg-white/80 backdrop-blur-sm border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm select-none">
                        Double-click anywhere · Drag codes onto cards
                    </p>
                </Panel>
            </ReactFlow>

            {/* Floating create form — rendered in screen space over the canvas */}
            {pendingCreate && (
                <FloatingCreateForm
                    screenX={pendingCreate.sx}
                    screenY={pendingCreate.sy}
                    onConfirm={handleCreateConfirm}
                    onCancel={() => setPendingCreate(null)}
                />
            )}
        </div>
    )
}

// ─── Public Export ────────────────────────────────────────────────────────────
interface ThemeCanvasProps {
    themes: ThemeNodeData[]
    projectId: string
    draggingCodeId: string | null
    draggingFromThemeId: string | null
    onDropCode: (themeId: string, codeId: string, fromThemeId?: string) => void
    onDropOnCanvas: (codeId: string, x: number, y: number, fromThemeId?: string) => void
    onEdit: (id: string, name: string, description: string) => void
    onDelete: (id: string, name: string) => void
    onRemoveCode: (themeId: string, codeId: string) => void
    onPositionSave: (themeId: string, x: number, y: number) => void
    onCreateTheme: (name: string, x: number, y: number) => void
    onDragStartCode: (codeId: string, themeId: string) => void
    onDragEndCode: () => void
    aiSuggestions?: any[]
    onAcceptSuggestion?: (name: string) => void
    onRejectSuggestion?: (name: string) => void
    onAcceptAllSuggestions?: () => void
    acceptingAllSuggestions?: boolean
    onDismissAllSuggestions?: () => void
    suggestionsLoading?: boolean
    suggestionsRemainingAfterBatch?: number
    onLoadNextBatch?: () => void
}

export default function ThemeCanvas(props: ThemeCanvasProps) {
    return (
        <ReactFlowProvider>
            <ThemeCanvasInner {...props} />
        </ReactFlowProvider>
    )
}
