import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function POST(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user ? (session.user as any).id : null;
        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const project = await prisma.project.findUnique({
            where: { id: params.projectId },
            include: {
                members: true,
                codebooks: true,
                themes: {
                    include: {
                        codeLinks: true,
                        relationsOut: true,
                    }
                },
                datasets: {
                    include: {
                        transcripts: {
                            include: {
                                segments: {
                                    include: {
                                        suggestions: {
                                            include: {
                                                reviewDecision: true
                                            }
                                        },
                                        codeAssignments: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        // 1. Create New Project
        const newProject = await prisma.project.create({
            data: {
                name: `${project.name} (Copy)`,
                description: project.description,
                coreOntology: project.coreOntology,
                researchQuestion: project.researchQuestion,
                aiSettings: project.aiSettings || {},
                members: {
                    create: project.members.map(m => ({
                        userId: m.userId,
                        role: m.role
                    }))
                }
            }
        });

        // 2. Clone Codebook
        const codebookIdMap = new Map<string, string>();
        for (const cb of project.codebooks) {
            const newCb = await prisma.codebookEntry.create({
                data: {
                    projectId: newProject.id,
                    name: cb.name,
                    definition: cb.definition,
                    type: cb.type,
                    examplesIn: cb.examplesIn,
                    examplesOut: cb.examplesOut,
                    memo: cb.memo
                }
            });
            codebookIdMap.set(cb.id, newCb.id);
        }

        // 3. Clone Themes & Links
        const themeIdMap = new Map<string, string>();
        for (const theme of project.themes) {
            const newTheme = await prisma.theme.create({
                data: {
                    projectId: newProject.id,
                    name: theme.name,
                    description: theme.description,
                    memo: theme.memo,
                    status: theme.status,
                    positionX: theme.positionX,
                    positionY: theme.positionY,
                }
            });
            themeIdMap.set(theme.id, newTheme.id);
        }

        // Theme Relations & Code Links
        for (const theme of project.themes) {
            const newThemeId = themeIdMap.get(theme.id);
            if (!newThemeId) continue;

            // Relations
            for (const rel of theme.relationsOut) {
                const newTargetId = themeIdMap.get(rel.targetId);
                if (newTargetId) {
                    await prisma.themeRelation.create({
                        data: {
                            sourceId: newThemeId,
                            targetId: newTargetId,
                            relationType: rel.relationType
                        }
                    });
                }
            }

            // Code Links
            for (const link of theme.codeLinks) {
                const newCodebookId = codebookIdMap.get(link.codebookEntryId);
                if (newCodebookId) {
                    await prisma.themeCodeLink.create({
                        data: {
                            themeId: newThemeId,
                            codebookEntryId: newCodebookId
                        }
                    });
                }
            }
        }

        // 4. Clone Datasets, Transcripts, Segments, Suggestions, Assignments
        for (const dataset of project.datasets) {
            const newDataset = await prisma.dataset.create({
                data: {
                    projectId: newProject.id,
                    name: dataset.name,
                    description: dataset.description,
                }
            });

            for (const transcript of dataset.transcripts) {
                const newTranscript = await prisma.transcript.create({
                    data: {
                        datasetId: newDataset.id,
                        title: transcript.title,
                        content: transcript.content,
                        status: transcript.status,
                        metadata: transcript.metadata || {}
                    }
                });

                for (const segment of transcript.segments) {
                    const newSegment = await prisma.segment.create({
                        data: {
                            transcriptId: newTranscript.id,
                            text: segment.text,
                            startIndex: segment.startIndex,
                            endIndex: segment.endIndex,
                            speaker: segment.speaker,
                            order: segment.order,
                        }
                    });

                    const suggestionIdMap = new Map<string, string>();

                    for (const sug of segment.suggestions) {
                        const newSug = await prisma.aISuggestion.create({
                            data: {
                                segmentId: newSegment.id,
                                label: sug.label,
                                explanation: sug.explanation,
                                confidence: sug.confidence,
                                alternatives: sug.alternatives,
                                uncertainty: sug.uncertainty,
                                promptVersion: sug.promptVersion,
                                modelProvider: sug.modelProvider,
                                status: sug.status,
                            }
                        });
                        suggestionIdMap.set(sug.id, newSug.id);

                        if (sug.reviewDecision) {
                            await prisma.reviewDecision.create({
                                data: {
                                    aiSuggestionId: newSug.id,
                                    action: sug.reviewDecision.action,
                                    note: sug.reviewDecision.note,
                                    reviewerId: sug.reviewDecision.reviewerId,
                                }
                            });
                        }
                    }

                    for (const assign of segment.codeAssignments) {
                        const newCodebookId = codebookIdMap.get(assign.codebookEntryId);
                        const newSugId = assign.aiSuggestionId ? suggestionIdMap.get(assign.aiSuggestionId) : null;
                        
                        if (newCodebookId) {
                            await prisma.codeAssignment.create({
                                data: {
                                    segmentId: newSegment.id,
                                    codebookEntryId: newCodebookId,
                                    aiSuggestionId: newSugId,
                                    confidence: assign.confidence,
                                }
                            });
                        }
                    }
                }
            }
        }

        return NextResponse.json({ success: true, newProjectId: newProject.id });
    } catch (e: any) {
        console.error('Duplicate error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
