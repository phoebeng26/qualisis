import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

function sanitise(value: string | null | undefined): string {
    return (value || '').replace(/[\r\n]+/g, ' ').replace(/"/g, '""').trim()
}

export async function GET(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    try {
        const rawThemes = await prisma.theme.findMany({
            where: { projectId: params.projectId, status: { not: 'MERGED' } },
            include: {
                relationsIn: { where: { relationType: 'SUBTHEME_OF' } },
                relationsOut: { where: { relationType: 'SUBTHEME_OF' } },
                codeLinks: {
                    include: {
                        codebookEntry: {
                            select: {
                                id: true,
                                name: true,
                                definition: true,
                                examplesIn: true,
                                codeAssignments: {
                                    where: {
                                        segment: {
                                            transcript: {
                                                dataset: { projectId: params.projectId }
                                            }
                                        }
                                    },
                                    select: {
                                        segment: {
                                            select: {
                                                text: true,
                                                transcript: { select: { title: true } }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
            },
            orderBy: { createdAt: 'desc' }
        })

        type Assignment = { segment: { text: string; transcript: { title: string } | null } | null }
        const getCodeStats = (codeAssignments: Assignment[]) => {
            const participantSet = new Set<string>()
            let sampleEvidence = ''
            for (const a of codeAssignments) {
                const pName = a.segment?.transcript?.title
                if (pName) participantSet.add(pName)
                if (!sampleEvidence && a.segment?.text) sampleEvidence = a.segment.text
            }
            return {
                numParticipants: participantSet.size,
                numPieces: codeAssignments.length,
                sampleEvidence,
                participantIds: Array.from(participantSet).join('; ')
            }
        }

        const BOM = '\uFEFF'
        const header = ['MEGA THEME', 'THEME', 'CODE', 'DEFINITION', 'SAMPLE EVIDENCE', 'PARTICIPANT IDS', 'THEME PARTICIPANT COUNT']
        const rows: string[][] = []

        // Extract top level themes (those that are not subthemes of any other theme)
        const topLevelThemes = rawThemes.filter(t => t.relationsOut.length === 0);

        for (const theme of topLevelThemes) {
            const childrenIds = theme.relationsIn.map(r => r.sourceId);
            const isMega = childrenIds.length > 0;

            if (isMega) {
                const megaThemeLabel = sanitise(theme.name);

                // For each sub-theme
                for (const subId of childrenIds) {
                    const subTheme = rawThemes.find(t => t.id === subId);
                    if (!subTheme) continue;
                    
                    const subThemeLabel = sanitise(subTheme.name);
                    const validLinks = subTheme.codeLinks.filter(l => l.codebookEntry.codeAssignments.length > 0);

                    const themeParticipants = new Set<string>();
                    for (const l of validLinks) {
                        l.codebookEntry.codeAssignments.forEach((ca: any) => {
                            if (ca.segment?.transcript) themeParticipants.add(ca.segment.transcript.title);
                        })
                    }
                    const themePartCount = themeParticipants.size.toString();

                    if (validLinks.length === 0) {
                        rows.push([megaThemeLabel, subThemeLabel, '-', '', '', '', '0']);
                    } else {
                        for (const link of validLinks) {
                            const stats = getCodeStats(link.codebookEntry.codeAssignments);
                            const definition = link.codebookEntry.definition || link.codebookEntry.examplesIn || '';
                            rows.push([
                                megaThemeLabel,
                                subThemeLabel,
                                sanitise(link.codebookEntry.name),
                                sanitise(definition),
                                sanitise(stats.sampleEvidence),
                                sanitise(stats.participantIds),
                                themePartCount
                            ]);
                        }
                    }
                }

                // If Mega Theme has direct codes assigned to it
                const directValidLinks = theme.codeLinks.filter(l => l.codebookEntry.codeAssignments.length > 0);
                if (directValidLinks.length > 0) {
                    const themeParticipants = new Set<string>();
                    for (const l of directValidLinks) {
                        l.codebookEntry.codeAssignments.forEach((ca: any) => {
                            if (ca.segment?.transcript) themeParticipants.add(ca.segment.transcript.title);
                        })
                    }
                    const themePartCount = themeParticipants.size.toString();

                    for (const link of directValidLinks) {
                        const stats = getCodeStats(link.codebookEntry.codeAssignments);
                        const definition = link.codebookEntry.definition || link.codebookEntry.examplesIn || '';
                        rows.push([
                            megaThemeLabel,
                            '-', // No subtheme
                            sanitise(link.codebookEntry.name),
                            sanitise(definition),
                            sanitise(stats.sampleEvidence),
                            sanitise(stats.participantIds),
                            themePartCount
                        ]);
                    }
                }

            } else {
                // It's a standalone theme
                const themeLabel = sanitise(theme.name);
                const validLinks = theme.codeLinks.filter(l => l.codebookEntry.codeAssignments.length > 0);

                const themeParticipants = new Set<string>();
                for (const l of validLinks) {
                    l.codebookEntry.codeAssignments.forEach((ca: any) => {
                        if (ca.segment?.transcript) themeParticipants.add(ca.segment.transcript.title);
                    })
                }
                const themePartCount = themeParticipants.size.toString();

                if (validLinks.length === 0) {
                    rows.push(['-', themeLabel, '-', '', '', '', '0']);
                } else {
                    for (const link of validLinks) {
                        const stats = getCodeStats(link.codebookEntry.codeAssignments);
                        const definition = link.codebookEntry.definition || link.codebookEntry.examplesIn || '';
                        rows.push([
                            '-',
                            themeLabel,
                            sanitise(link.codebookEntry.name),
                            sanitise(definition),
                            sanitise(stats.sampleEvidence),
                            sanitise(stats.participantIds),
                            themePartCount
                        ]);
                    }
                }
            }
        }

        const csv = BOM + [header, ...rows]
            .map(row => row.map(cell => `"${cell}"`).join(','))
            .join('\r\n')

        return new NextResponse(csv, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="codebook.csv"',
                'Cache-Control': 'no-store',
            }
        })
    } catch (e) {
        console.error('CSV export error:', e)
        return NextResponse.json({ error: 'Failed to export codebook' }, { status: 500 })
    }
}
