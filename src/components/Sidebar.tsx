'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { signOut } from 'next-auth/react'
import UploadDatasetWrapper from './UploadDatasetWrapper'

type Transcript = { id: string; title: string; status: string }
type Dataset = { id: string; name: string; transcripts: Transcript[] }
type Project = { id: string; name: string; description: string | null; datasets: Dataset[] }

const statusDot: Record<string, string> = {
    PENDING: 'bg-amber-400',
    REVIEWING: 'bg-blue-400',
    CODED: 'bg-emerald-400',
    DONE: 'bg-slate-300',
}

export default function Sidebar({ project }: { project: Project }) {
    const pathname = usePathname()
    const [collapsed, setCollapsed] = useState(false)
    const [codingOpen, setCodingOpen] = useState(true)

    const allTranscripts = project.datasets.flatMap((d) => d.transcripts)

    // Active detection helpers
    const isTranscriptsActive = pathname === `/projects/${project.id}` || pathname.includes('/transcripts')
    const isThemesActive = pathname.includes('/themes')
    const isCodebookActive = pathname.includes('/codebook')
    const isReportActive = pathname.includes('/report')

    return (
        <aside className={`${collapsed ? 'w-16' : 'w-[260px]'} flex flex-col h-full bg-slate-50 border-r border-slate-200 transition-all duration-200 flex-shrink-0`}>
            {/* Header */}
            <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200 flex-shrink-0">
                <Link href="/projects" className="flex items-center gap-2 text-slate-800 hover:text-indigo-600 transition-colors" title="Back to Dashboard">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-600"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                    {!collapsed && <span className="font-extrabold text-[15px] tracking-tight">QualiSIS</span>}
                </Link>
                <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="p-1 rounded-md text-slate-400 hover:bg-slate-200 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {collapsed ? <path d="m9 18 6-6-6-6" /> : <path d="m15 18-6-6 6-6" />}
                    </svg>
                </button>
            </div>

            {/* Project Context */}
            {!collapsed && (
                <div className="px-4 py-4 bg-white border-b border-slate-200 shadow-sm flex-shrink-0 mb-2">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-0-2.5Z"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg> Active Project</div>
                    <div className="text-[13px] font-extrabold text-slate-800 line-clamp-2 leading-tight">
                        {project.name}
                    </div>
                </div>
            )}

            {/* Navigation */}
            <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-4">
                {!collapsed && <div className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest pl-3 mb-2">Phase 1: Data & Coding</div>}
                
                {/* ① Transcripts */}
                <div className="mb-1">
                    <div className="flex items-center w-full relative">
                        <Link
                            href={`/projects/${project.id}`}
                            className={`flex-1 flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                                isTranscriptsActive
                                    ? 'bg-white border border-slate-200 shadow-sm text-indigo-700 font-semibold'
                                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-medium border border-transparent'
                            }`}
                        >
                            <span className={isTranscriptsActive ? 'text-indigo-600' : 'text-slate-400'}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                            </span>
                            {!collapsed && <span className="text-sm">① Transcripts</span>}
                        </Link>
                        {!collapsed && (
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    setCodingOpen(!codingOpen);
                                }}
                                className="absolute right-2 p-1.5 rounded-md hover:bg-slate-100/50 text-slate-400 hover:text-slate-600 transition-colors z-10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-200 ${codingOpen ? 'rotate-180' : ''}`}>
                                    <path d="m6 9 6 6 6-6" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Transcripts sub-list */}
                    {codingOpen && !collapsed && (
                        <div className="ml-4 pl-4 border-l-2 border-slate-100 mb-2 mt-1 space-y-1">
                            {allTranscripts.map((t: any) => {
                                const isActive = pathname === `/projects/${project.id}/transcripts/${t.id}`
                                return (
                                    <Link
                                        key={t.id}
                                        href={`/projects/${project.id}/transcripts/${t.id}`}
                                        className={`block px-3 py-1.5 rounded-lg text-[13px] transition-colors truncate ${
                                            isActive
                                                ? 'bg-indigo-50 text-indigo-700 font-bold'
                                                : 'text-slate-500 font-medium hover:bg-slate-100 hover:text-slate-800'
                                        }`}
                                    >
                                        <span className="mr-2 text-indigo-300">•</span>
                                        {t.title}
                                    </Link>
                                )
                            })}
                            {allTranscripts.length === 0 ? (
                                <div className="px-3 py-1 text-[11px] text-slate-400 italic">No transcripts</div>
                            ) : (
                                <div className="px-2 mt-2 mb-1">
                                    <UploadDatasetWrapper projectId={project.id} asSidebarIcon />
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {!collapsed && <div className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest pl-3 mt-6 mb-2">Phase 2: Analysis & Synthesis</div>}

                {/* ② Analysis Workspace */}
                <Link
                    href={`/projects/${project.id}/themes`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all mb-1 ${
                        isThemesActive
                            ? 'bg-white border border-slate-200 shadow-sm text-indigo-700 font-semibold'
                            : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-medium border border-transparent'
                    }`}
                >
                    <span className={isThemesActive ? 'text-indigo-600' : 'text-slate-400'}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
                    </span>
                    {!collapsed && <span className="text-sm">Analysis Workspace</span>}
                </Link>

                {/* ③ Codebook */}
                <Link
                    href={`/projects/${project.id}/codebook`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all mb-1 ${
                        isCodebookActive
                            ? 'bg-white border border-slate-200 shadow-sm text-indigo-700 font-semibold'
                            : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-medium border border-transparent'
                    }`}
                >
                    <span className={isCodebookActive ? 'text-indigo-600' : 'text-slate-400'}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                    </span>
                    {!collapsed && <span className="text-sm">Final Codebook</span>}
                </Link>


                {!collapsed && <div className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest pl-3 mt-6 mb-2">Utilities</div>}


                {/* Chat Copilot */}
                <Link
                    href={`/projects/${project.id}/chat`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all mb-1 ${
                        pathname.includes('/chat')
                            ? 'bg-white border border-slate-200 shadow-sm text-indigo-700 font-semibold'
                            : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-medium border border-transparent'
                    }`}
                >
                    <span className={pathname.includes('/chat') ? 'text-indigo-600' : 'text-slate-400'}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </span>
                    {!collapsed && <span className="text-sm">Chat with Data</span>}
                </Link>
            </div>

            {/* Footer */}
            <div className="px-4 pb-5 pt-2 border-t border-slate-200 flex-shrink-0">
                <Link
                    href={`/projects/${project.id}/settings`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                        pathname.includes('/settings')
                            ? 'bg-white border border-slate-200 shadow-sm text-indigo-700 font-semibold'
                            : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 font-medium border border-transparent'
                    }`}
                >
                    <span className={pathname.includes('/settings') ? 'text-indigo-600' : 'text-slate-400'}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                    </span>
                    {!collapsed && <span className="text-sm">Project Settings</span>}
                </Link>

                <button
                    onClick={async () => {
                        await signOut({ redirect: false })
                        window.location.href = '/login'
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 mt-1 rounded-xl transition-all text-slate-500 hover:text-rose-600 hover:bg-rose-50/50 font-medium border border-transparent"
                >
                    <span className="text-slate-400">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
                    </span>
                    {!collapsed && <span className="text-sm text-left">Sign Out</span>}
                </button>
            </div>
        </aside>
    )
}
