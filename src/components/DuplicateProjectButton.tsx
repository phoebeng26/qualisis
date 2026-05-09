'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy } from 'lucide-react'
import ConfirmModal from './ConfirmModal'

export default function DuplicateProjectButton({ 
    projectId, 
    projectName 
}: { 
    projectId: string
    projectName: string 
}) {
    const [isDuplicating, setIsDuplicating] = useState(false)
    const router = useRouter()
    const [showConfirm, setShowConfirm] = useState(false)

    const handleDuplicateClick = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setShowConfirm(true)
    }

    const confirmDuplicate = async () => {
        setShowConfirm(false)
        setIsDuplicating(true)
        try {
            const res = await fetch(`/api/projects/${projectId}/duplicate`, { method: 'POST' })
            if (res.ok) {
                router.refresh()
            } else {
                console.error('Failed to duplicate project')
            }
        } catch (error) {
            console.error('Duplicate error', error)
        } finally {
            setIsDuplicating(false)
        }
    }

    return (
        <>
            <button
                onClick={handleDuplicateClick}
                disabled={isDuplicating}
                className={`absolute top-4 right-14 p-2 bg-white rounded-lg shadow-sm border text-slate-400 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 transition-all z-10 
                ${isDuplicating ? 'opacity-50 cursor-not-allowed' : 'opacity-0 group-hover:opacity-100 border-slate-200'}`}
                title="Duplicate project"
            >
                {isDuplicating ? (
                    <svg className="w-4 h-4 animate-spin text-indigo-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                ) : (
                    <Copy className="w-4 h-4" />
                )}
            </button>
            <ConfirmModal
                isOpen={showConfirm}
                title="Duplicate Project"
                message={`Are you sure you want to duplicate "${projectName}"?\n\nThis will create a full copy including datasets, transcripts, codebooks, and themes.`}
                confirmText="Duplicate"
                onConfirm={confirmDuplicate}
                onCancel={() => setShowConfirm(false)}
            />
        </>
    )
}
