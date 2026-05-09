import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function cleanQuote(text: string): string {
    return text
        .replace(/(?:\d{2}:)?\d{2}:\d{2}\s*Speaker\s*\d+\s*/gi, '')
        .replace(/Speaker\s*\d+\s*(?:\d{2}:)?\d{2}:\d{2}\s*/gi, '')
        .replace(/(?:\d{2}:)?\d{2}:\d{2}\s*/g, '')
        .replace(/Speaker\s*\d+\s*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
}

export async function POST(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    try {
        // 1. Fetch project info
        const project = await prisma.project.findUnique({
            where: { id: params.projectId },
            select: { name: true, description: true, researchQuestion: true, coreOntology: true }
        })
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

        // 2. Fetch themes with codes + quotes
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

        // 3. Build compact codebook evidence block for the prompt
        const codebookEvidence = rawThemes.map(theme => {
            const codes = theme.codeLinks.map(link => {
                const quotes = link.codebookEntry.codeAssignments
                    .filter(a => a.segment?.text)
                    .map(a => `    → "${cleanQuote(a.segment!.text)}" [${a.segment?.transcript?.title || 'Participant'}]`)
                    .join('\n')
                return `  • ${link.codebookEntry.name} (n=${link.codebookEntry._count.codeAssignments}): ${link.codebookEntry.definition || ''}\n${quotes}`
            }).join('\n\n')

            return `**Theme: ${theme.name}**\n${theme.description ? `Summary: ${theme.description}\n` : ''}Codes:\n${codes}`
        }).join('\n\n---\n\n')

        const researchQuestion = project.researchQuestion || '(not specified)'
        const fieldContext = project.coreOntology || project.description || '(qualitative research)'
        const now = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })

        // 4. PHASE 1 — Synthesize what the literature already says
        const literatureSynthesisPrompt = `You are an expert academic researcher with deep knowledge of the most current peer-reviewed literature (up to 2024-2025).

The researcher is studying this research question:
"${researchQuestion}"

Field/Context: ${fieldContext}

YOUR TASK — LITERATURE SYNTHESIS:
Write a structured synthesis of what the MOST RECENT peer-reviewed academic literature (prioritise 2022–2025) already knows about this topic.

For each major area the literature covers, write 2-3 sentences summarising the current scholarly consensus. Reference real, plausible author names, journals, and years (draw on your training knowledge of real papers in HCI, CSCW, qualitative methods, AI-assisted research, etc. as relevant).

Structure your synthesis as:
## What Existing Literature Already Knows

### [Sub-topic Area 1]
[2-3 sentences of synthesis with citations]

### [Sub-topic Area 2]
[2-3 sentences]

(continue for 4-6 sub-areas most relevant to the research question)

Be precise and academically rigorous. Do NOT fabricate findings; draw on real scholarly conversations.`

        const litCompletion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: literatureSynthesisPrompt }],
            temperature: 0.3,
            max_tokens: 1800,
        })
        const literatureSynthesis = litCompletion.choices[0]?.message?.content || ''

        // 5. PHASE 2 — Thesis-argument structured discussion
        const gapAnalysisPrompt = `You are an expert qualitative researcher writing the "Discussion" chapter for a peer-reviewed thesis.

RESEARCH QUESTION (anchor everything here):
"${researchQuestion}"

WHAT THE LITERATURE ALREADY SAYS (synthesised from peer-reviewed sources):
${literatureSynthesis}

WHAT THE RESEARCHER'S DATA SHOWS (codebook from empirical fieldwork):
${codebookEvidence}

---

YOUR TASK — WRITE A THESIS-ARGUMENT STRUCTURED DISCUSSION:

This is NOT a list of gaps. It is a SINGLE, COHERENT ARGUMENT built through multiple interconnected analytic moves.

The logic is: ONE CENTRAL CLAIM → Literature produces the blind spot → Each finding advances the argument → Conceptual reframing

BEFORE writing, identify ONE sentence: the core theoretical contribution this data makes. This is a reframing — not a summary. Every section must serve this claim.

Write with this EXACT structure:

---

# Discussion: [A short argumentative title — a claim, not a description]

## The Central Argument
3–4 sentences. State the ONE core claim. Name what assumption in the existing literature it challenges. Use: "This study argues that...", "Contrary to the prevailing focus on X, the data reveals...", "The key issue is not X but Y."

## What the Literature Has Framed — and Why That Framing Is Insufficient
4–6 sentences in ONE flowing paragraph (not a list). Synthesise 2–3 ways the literature has approached this topic. For each: what it covers, and what it systematically cannot see. Show how they collectively produce the blind spot this study's data addresses.

## Analytic Move 1: [verb-noun reframing — e.g. "Reframing X as Y", "From X to Y", NOT "Gap 1"]
5–7 sentences. Tension → finding → argument advance → embedded quote(s) in prose.

## Analytic Move 2: [verb-noun reframing]
5–7 sentences. Same structure.

## Analytic Move 3: [verb-noun reframing]
5–7 sentences. Same structure.

## Analytic Move 4: [Only if clearly supported by a fourth distinct data cluster]
5–7 sentences. Same structure.

## Conceptual Contribution: Towards [Name of a new concept, reframing, or framework]
4–5 sentences. Name the contribution explicitly. A reframing — not a summary. This is the thesis's original insight. Connect back to the Central Argument.

## Implications

### For Research
- [Specific future study direction 1]
- [Direction 2]
- [Direction 3]

### For Practice
- [How practitioners should act differently 1]
- [Implication 2]

---

CRITICAL RULES:
- Every move must connect back to the Central Claim. Drop any move that does not serve it.
- Do NOT invent participant quotes. Use ONLY quotes from the codebook data provided above.
- Strip timestamps (e.g. "00:20:13") and "Speaker X" labels from quotes before using them.
- Write in the register of a strong qualitative thesis — analytical, precise, not hedged.
- Never say "Gap 1", "Gap 2". This is an argument, not a list.
- The Conceptual Contribution must name something new — a concept, reframing, or framework.
- Analytic move titles must be verb-noun phrases that name what the move does analytically.`

        const gapCompletion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: gapAnalysisPrompt }],
            temperature: 0.35,
            max_tokens: 4000,
        })
        const gapAnalysis = gapCompletion.choices[0]?.message?.content || ''

        // 6. Build stats for report header
        const participantSet = new Set<string>()
        rawThemes.forEach(t => t.codeLinks.forEach(l =>
            l.codebookEntry.codeAssignments.forEach(a => {
                if (a.segment?.transcript?.title) participantSet.add(a.segment.transcript.title)
            })
        ))
        const totalCodesCount = rawThemes.reduce((acc, t) => acc + t.codeLinks.length, 0)

        // 7. Build codebook appendix table
        const appendixRows = rawThemes.flatMap(t =>
            t.codeLinks.map(l => {
                const codeDef = `**${l.codebookEntry.name}**<br>_${(l.codebookEntry.definition || 'No definition provided').replace(/\|/g, '/')}_`
                const sampleQuote = l.codebookEntry.codeAssignments.find(a => a.segment?.text)?.segment
                const quoteHtml = sampleQuote
                    ? `"${cleanQuote(sampleQuote.text).replace(/\|/g, '/')}"<br>— ${sampleQuote.transcript?.title || 'Participant'}`
                    : '—'
                return `| **${t.name}** | ${codeDef} | ${quoteHtml} |`
            })
        )

        // 8. Assemble full report
        const fullReport = `# Research Gap Analysis: ${project.name}

**Generated:** ${now}
**Analysis Method:** AI-Assisted Thematic Analysis & Literature Gap Mapping (QualiSIS)
**Participants:** ${participantSet.size}
**Themes:** ${rawThemes.length}
**Total Codes:** ${totalCodesCount}

---

## Research Question

${researchQuestion}

---

${literatureSynthesis}

---

${gapAnalysis}

---

## Appendix: Codebook Summary

| Theme | Code · Definition | Sample Excerpt |
|---|---|---|
${appendixRows.join('\n')}

---

*This report was generated with AI assistance using QualiSIS. Literature references draw on the model's training knowledge and should be verified before submission. All thematic interpretations should be reviewed and validated by the researcher.*`

        return NextResponse.json({ report: fullReport })

    } catch (e: any) {
        console.error('Report generation error:', e)
        return NextResponse.json({ error: e.message || 'Failed to generate report' }, { status: 500 })
    }
}
