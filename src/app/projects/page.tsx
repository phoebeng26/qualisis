import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'
import CreateProjectButton from '@/components/CreateProjectButton'
import DeleteProjectButton from '@/components/DeleteProjectButton'
import DuplicateProjectButton from '@/components/DuplicateProjectButton'
import { UserDropdown } from '@/components/UserDropdown'
import GlobalSignOutButton from '@/components/GlobalSignOutButton'
import { Network, Home, Settings, Plus, FolderOpen, FileText } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function ProjectsDashboard() {
    const session = await getServerSession(authOptions)
    const userId = session?.user ? (session.user as any).id : null

    if (!userId) {
        redirect('/login')
    }

    const projects = await prisma.project.findMany({
        where: {
            members: {
                some: { userId }
            }
        },
        include: {
            datasets: {
                include: { _count: { select: { transcripts: true } } }
            }
        },
        orderBy: { updatedAt: 'desc' }
    })

    return (
        <div className="flex h-screen w-full bg-slate-50/50 overflow-hidden">
            {/* MAIN CONTENT (No Sidebar for Dashboard) */}
            <main className="flex-1 flex flex-col h-full bg-slate-50/50 overflow-y-auto relative w-full">
                {/* Header Navbar */}
                <div className="h-16 border-b border-slate-200/60 bg-white/80 backdrop-blur-md flex items-center justify-between px-8 flex-shrink-0 sticky top-0 z-50 w-full shadow-sm">
                    {/* Logo Area */}
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0 text-white font-bold shadow-sm">
                            <Network className="w-4 h-4" />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-sm font-extrabold text-slate-800 tracking-tight leading-tight">QualiSIS</span>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Traceable AI Workstation</span>
                        </div>
                    </div>

                    {/* Actions Area */}
                    <div className="flex items-center gap-5">
                        <CreateProjectButton />
                        <div className="h-6 w-px bg-slate-200"></div>
                        <UserDropdown />
                    </div>
                </div>

                <div className="p-10 max-w-6xl mx-auto w-full">


                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-xl font-extrabold text-slate-800 tracking-tight">Your Projects</h2>
                    </div>

                    {/* Projects Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <div className="relative animate-[fade-in-up_0.5s_ease-out_0.5s_both]">
                            <CreateProjectCardTrigger />
                        </div>

                        {projects.map((p, index) => {
                            const totalTranscripts = p.datasets.reduce((sum, ds) => sum + ds._count.transcripts, 0)
                            return (
                                <div 
                                    key={p.id}
                                    className="bg-white border text-left border-slate-200 rounded-2xl p-6 hover:shadow-lg hover:border-indigo-300 transition-all group relative overflow-hidden h-64 flex flex-col"
                                    style={{ animation: `fade-in-up 0.5s ease-out ${0.5 + (index * 0.1)}s both` }}
                                >
                                    <Link href={`/projects/${p.id}`} className="absolute inset-0 z-0" aria-label={`View ${p.name}`} />
                                    <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity z-0" />
                                    
                                    <DeleteProjectButton projectId={p.id} projectName={p.name} />
                                    <DuplicateProjectButton projectId={p.id} projectName={p.name} />
                                    
                                    <h3 className="relative z-10 font-bold text-slate-800 text-lg mb-2 pr-8 pointer-events-none group-hover:text-indigo-700 transition-colors">{p.name}</h3>
                                    <p className="relative z-10 text-slate-500 text-sm line-clamp-3 mb-auto h-16 pointer-events-none">
                                        {p.description || "No description provided."}
                                    </p>
                                    
                                    <div className="relative z-10 flex items-center justify-between text-sm text-slate-500 border-t border-slate-100 pt-4 mt-auto w-full pointer-events-none">
                                        <div className="flex gap-4">
                                            <span className="flex items-center gap-1.5 font-medium" title="Datasets">
                                                <FolderOpen className="w-4 h-4 text-slate-400" /> {p.datasets.length}
                                            </span>
                                            <span className="flex items-center gap-1.5 font-medium" title="Transcripts">
                                                <FileText className="w-4 h-4 text-slate-400" /> {totalTranscripts}
                                            </span>
                                        </div>
                                        <span className="text-[11px] font-bold text-slate-400 bg-slate-50 px-2 py-0.5 rounded">
                                            {p.updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </span>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>

                <style dangerouslySetInnerHTML={{__html: `
                    @keyframes fade-in {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }
                    @keyframes fade-in-up {
                        from { opacity: 0; transform: translateY(15px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                `}} />
            </main>
        </div>
    )
}

function CreateProjectCardTrigger() {
    return (
        <CreateProjectButton asCard />
    )
}
