import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    try {
        // 1. Fetch project info
        const project = await prisma.project.findUnique({
            where: { id: params.projectId },
            select: { name: true, description: true, researchQuestion: true }
        })
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

        // 2. Fetch themes with codes + up to 3 quotes per code
        const rawThemes = await prisma.theme.findMany({
            where: { projectId: params.projectId, status: { not: 'MERGED' } },
            include: {
                relationsOut: { where: { relationType: 'SUBTHEME_OF' } },
                codeLinks: {
                    include: {
                        codebookEntry: {
                            select: {
                                name: true,
                                definition: true,
                                _count: { select: { codeAssignments: true } },
                                codeAssignments: {
                                    take: 3,
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

        // 3. Helper: format a single theme's codes into text
        const formatCodes = (theme: typeof rawThemes[0]) => {
            if (theme.codeLinks.length === 0) return '  (no codes assigned yet)'
            return theme.codeLinks.map(link => {
                const quotes = link.codebookEntry.codeAssignments
                    .filter(a => a.segment?.text)
                    .map(a => `      - "${a.segment!.text}" [${a.segment?.transcript?.title || 'Participant'}]`)
                    .join('\n')
                return `  • Code: ${link.codebookEntry.name} (${link.codebookEntry._count.codeAssignments} instances)\n    Definition: ${link.codebookEntry.definition || '(no definition)'}\n    Sample quotes:\n${quotes || '      (none)'}`
            }).join('\n\n')
        }

        // 4. Build hierarchical theme summary for prompt
        const standaloneThemes = rawThemes.filter(t => t.relationsOut.length === 0)
        
        const themesSummary = standaloneThemes.map(parentTheme => {
            // Find children (where this parent is the target of a SUBTHEME_OF relation)
            const children = rawThemes.filter(child => 
                child.relationsOut.some(r => r.targetId === parentTheme.id)
            )
            
            let block = `## Mega-Theme / Primary Theme: ${parentTheme.name}\nDescription: ${parentTheme.description || '(no description)'}\n\nCodes (direct):\n${formatCodes(parentTheme)}\n`
            
            if (children.length > 0) {
                block += `\n### Sub-Themes under "${parentTheme.name}":\n`
                children.forEach(child => {
                    block += `#### Sub-Theme: ${child.name}\nDescription: ${child.description}\nCodes:\n${formatCodes(child)}\n\n`
                })
            }
            return block
        }).join('\n\n---\n\n')

        const researchQuestions = project.researchQuestion || '(not specified)'

        const systemPrompt = `You are an expert qualitative researcher writing the "Thematic Findings" section of an academic research report. 
Write in a scholarly but accessible tone. Use first person plural ("we found", "the analysis revealed").
Your PRIMARY GOAL is to directly answer the provided RESEARCH QUESTION. Do not just summarize the data; explain what the data means in the context of the Research Question.
Always embed verbatim quotes from participants to evidence each point. 
Format output in clean Markdown with clear headings.`

        const userPrompt = `Write the full "Thematic Findings" section for this study.

PROJECT: ${project.name}
TOPIC: ${project.description || '(see project name)'}
RESEARCH QUESTION (Highest Priority):
${researchQuestions}

CODEBOOK DATA (Hierarchical Mega-Themes & Sub-Themes):
${themesSummary}

---

Instructions:
1. Write an INTRODUCTION paragraph (2-3 sentences) framing the overall findings as a direct response to the Research Question.
2. For each Mega-Theme / Primary Theme, write a FULL narrative section that:
   - Explains the core insight of this Mega-Theme and how it answers the Research Question.
   - If it has Sub-Themes, weave their findings into the narrative cohesively (do not just list them).
   - Weaves in 3-5 verbatim participant quotes as evidence (format: *"quote text"* [ParticipantName]).
3. Write a SYNTHESIS paragraph (3-4 sentences) identifying cross-cutting patterns across all Mega-Themes.
4. Use this exact heading structure:
   - # Thematic Findings
   - ## 1. [Mega-Theme Name]
      (narrative text...)
   - ## Synthesis and Cross-Cutting Patterns

Be highly analytical. Do NOT invent quotes — use only those provided above.`

        // 5. Call OpenAI
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.4,
            max_tokens: 4000,
        })

        const reportMarkdown = completion.choices[0]?.message?.content || ''

        // 6. Build full report with metadata sections
        const now = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
        const participantSet = new Set<string>()
        rawThemes.forEach(t => t.codeLinks.forEach(l =>
            l.codebookEntry.codeAssignments.forEach(a => {
                if (a.segment?.transcript?.title) participantSet.add(a.segment.transcript.title)
            })
        ))

        const totalCodesCount = rawThemes.reduce((acc, t) => acc + t.codeLinks.length, 0)

        // Build flat appendix table
        const appendixRows = rawThemes.flatMap(t =>
            t.codeLinks.map(l => {
                const codeDef = `**${l.codebookEntry.name}**<br>_${(l.codebookEntry.definition || 'No definition provided').replace(/\|/g, '/')}_`
                const sampleQuote = l.codebookEntry.codeAssignments.find(a => a.segment?.text)?.segment
                const quoteHtml = sampleQuote ? `"${sampleQuote.text.replace(/\|/g, '/')}"<br>— ${sampleQuote.transcript?.title || 'Participant'}` : '—'
                return `| **${t.name}** | ${codeDef} | ${quoteHtml} |`
            })
        )

        const fullReport = `# Research Report: ${project.name}

**Generated:** ${now}  
**Analysis Method:** AI-Assisted Thematic Analysis (QualiSIS)  
**Participants:** ${participantSet.size}  
**Themes:** ${rawThemes.length}  
**Total Codes:** ${totalCodesCount}

---

## Research Questions

${researchQuestions}

---

${reportMarkdown}

---

## Appendix: Codebook Summary

| Theme | Code · Definition | Sample Excerpt |
|---|---|---|
${appendixRows.join('\n')}

---

*This report was generated with AI assistance using QualiSIS. All thematic interpretations should be reviewed and validated by the researcher.*`

        return NextResponse.json({ report: fullReport })

    } catch (e: any) {
        console.error('Report generation error:', e)
        return NextResponse.json({ error: e.message || 'Failed to generate report' }, { status: 500 })
    }
}
