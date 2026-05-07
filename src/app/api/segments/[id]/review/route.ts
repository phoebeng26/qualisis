import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

// POST /api/segments/[id]/review
// body: { action: "ACCEPT" | "OVERRIDE" | "REJECT", note?: string, customLabel?: string, suggestionId: string }
export async function POST(
    req: Request,
    { params }: { params: { id: string } }
) {
    try {
        const body = await req.json()
        const { action, note, customLabel, suggestionId } = body

        const session = await getServerSession(authOptions)
        const userId = session?.user ? (session.user as any).id : null

        if (!suggestionId || !action) {
            return NextResponse.json({ error: 'suggestionId and action are required' }, { status: 400 })
        }

        // Verify suggestion exists
        const suggestion = await prisma.aISuggestion.findUnique({
            where: { id: suggestionId },
            include: { segment: true }
        })
        if (!suggestion) {
            return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 })
        }

        // If RESTORE: delete ReviewDecision and CodeAssignment
        if (action === 'RESTORE') {
            await prisma.reviewDecision.deleteMany({
                where: { aiSuggestionId: suggestionId }
            })
            await prisma.codeAssignment.deleteMany({
                where: { aiSuggestionId: suggestionId }
            })
        } else {
            // Create or update ReviewDecision
            await prisma.reviewDecision.upsert({
                where: { aiSuggestionId: suggestionId },
                update: { action, note: note ?? null },
                create: {
                    aiSuggestionId: suggestionId,
                    action,
                    note: note ?? null,
                    reviewerId: userId || 'researcher-1', // Fallback if no auth
                }
            })
        }

        // Update suggestion status
        const newStatus =
            action === 'ACCEPT' ? 'APPROVED' :
            action === 'REJECT' ? 'REJECTED' :
            action === 'OVERRIDE' ? 'MODIFIED' :
            action === 'RESTORE' ? 'SUGGESTED' : 'UNDER_REVIEW'

        await prisma.aISuggestion.update({
            where: { id: suggestionId },
            data: { 
                status: newStatus,
                ...(action === 'OVERRIDE' && customLabel ? { label: customLabel } : {})
            }
        })

        // If ACCEPT or OVERRIDE: create/update CodeAssignment
        if (action === 'ACCEPT' || action === 'OVERRIDE') {
            const finalLabel = customLabel ? customLabel : suggestion.label

            // Find or create codebook entry
            let codebookEntry = await prisma.codebookEntry.findFirst({
                where: {
                    name: { equals: finalLabel, mode: 'insensitive' },
                    projectId: { not: undefined }
                }
            })

            // Get projectId via segment → transcript → dataset → project chain
            const transcriptData = await prisma.transcript.findUnique({
                where: { id: suggestion.segment.transcriptId },
                include: { dataset: true }
            })
            const projectId = transcriptData?.dataset.projectId

            const finalDefinition = note 
                ? `${suggestion.explanation}\n\n[Researcher Note]: ${note}` 
                : suggestion.explanation;

            if (!codebookEntry && projectId) {
                codebookEntry = await prisma.codebookEntry.create({
                    data: {
                        projectId,
                        name: finalLabel,
                        definition: finalDefinition,
                        type: 'RAW',
                        examplesIn: `"${suggestion.segment.text.substring(0, 100)}"`,
                        examplesOut: '',
                    }
                })
            } else if (codebookEntry && note) {
                // If it already exists, append the new note to its definition
                if (!codebookEntry.definition?.includes(note)) {
                    await prisma.codebookEntry.update({
                        where: { id: codebookEntry.id },
                        data: {
                            definition: `${codebookEntry.definition || ''}\n\n[Additional Review Note]: ${note}`.trim()
                        }
                    })
                }
            }

            if (codebookEntry) {
                await prisma.codeAssignment.upsert({
                    where: { aiSuggestionId: suggestionId },
                    update: {
                        codebookEntryId: codebookEntry.id,
                        confidence: suggestion.confidence,
                    },
                    create: {
                        segmentId: params.id,
                        codebookEntryId: codebookEntry.id,
                        aiSuggestionId: suggestionId,
                        confidence: suggestion.confidence,
                    }
                })
            }
        }

        // Audit log
        await prisma.auditLog.create({
            data: {
                userId,
                eventType: action === 'RESTORE' ? 'REVIEW_DECISION_RESTORED' : 'REVIEW_DECISION_MADE',
                entityType: 'AISuggestion',
                entityId: suggestionId,
                oldValue: suggestion.status,
                newValue: newStatus,
                note: note ?? null,
            }
        })

        return NextResponse.json({ success: true, action, newStatus })
    } catch (e) {
        console.error('Review error:', e)
        return NextResponse.json({ error: 'Failed to save review', details: String(e) }, { status: 500 })
    }
}
