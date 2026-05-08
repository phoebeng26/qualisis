import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

/** Word-overlap similarity — same heuristic used in compare-codes. Returns 0–1. */
function wordSimilarity(a: string, b: string): number {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
    const wa = new Set(normalize(a))
    const wb = new Set(normalize(b))
    if (wa.size === 0 || wb.size === 0) return 0
    let intersection = 0
    wa.forEach(w => { if (wb.has(w)) intersection++ })
    return intersection / Math.min(wa.size, wb.size)
}

// POST /api/projects/[projectId]/suggest-themes
// body: { codeLabel: string, excerpt: string }
// Returns 3 theme suggestions — with full semantic context per existing theme
export async function POST(req: Request, { params }: { params: { projectId: string } }) {
    try {
        const { codeLabel, excerpt } = await req.json()
        if (!codeLabel || !excerpt) {
            return NextResponse.json({ error: 'codeLabel and excerpt required' }, { status: 400 })
        }

        // Fetch project context
        const project = await prisma.project.findUnique({
            where: { id: params.projectId },
            select: { researchQuestion: true, description: true }
        })

        // Fetch ALL current themes WITH their existing code links for richer AI context
        const existingThemes = await prisma.theme.findMany({
            where: { projectId: params.projectId },
            select: {
                id: true,
                name: true,
                description: true,
                codeLinks: {
                    select: {
                        codebookEntry: { select: { name: true } }
                    },
                    take: 8  // show up to 8 sample codes per theme
                }
            },
            orderBy: { createdAt: 'asc' }
        })

        const rqContext = project?.researchQuestion
            ? `Research Question: ${project.researchQuestion}`
            : ''

        // Build rich theme descriptions including existing codes
        const existingList = existingThemes.length > 0
            ? existingThemes.map(t => {
                const codeNames = t.codeLinks.map(l => `"${l.codebookEntry.name}"`).join(', ')
                const codeContext = codeNames ? `\n     Contains codes: ${codeNames}` : ''
                const descContext = t.description ? `\n     Description: ${t.description.substring(0, 80)}` : ''
                return `• THEME: "${t.name}"${descContext}${codeContext}`
            }).join('\n\n')
            : '(No themes created yet — all suggestions will be new)'

        const prompt = `You are an expert qualitative researcher doing thematic analysis.

${rqContext}

A researcher has coded this excerpt with the label: "${codeLabel}"
Excerpt: "${excerpt.substring(0, 300)}"

Current themes already in this project (with their existing codes):
${existingList}

Task: Suggest exactly 3 theme options for this code. Prioritize semantic fit:

1. FIRST check each existing theme — look at its name AND the codes already inside it. If "${codeLabel}" belongs conceptually with those codes, REUSE that theme. Copy its exact name.
2. If no existing theme fits well, propose a NEW interpretive theme. It must be abstract and theoretically meaningful — not just a restatement of the code label.
3. Vary abstraction levels across the 3 suggestions.

Return ONLY a raw JSON array, no markdown fences:
[
  { "label": "Exact existing theme name OR new name", "isExisting": true, "reasoning": "One sentence explaining the semantic fit" },
  { "label": "Another option", "isExisting": false, "reasoning": "One sentence why" },
  { "label": "Third option", "isExisting": false, "reasoning": "One sentence why" }
]`

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.6,
            max_tokens: 500,
        })

        const raw = (response.choices[0].message.content || '[]').trim()
            .replace(/^```json\n?/, '').replace(/```$/, '').trim()

        let suggestions: { label: string; isExisting: boolean; reasoning?: string }[] = []
        try {
            const parsed = JSON.parse(raw)
            suggestions = Array.isArray(parsed) ? parsed : []
        } catch { suggestions = [] }

        // Fuzzy-match each suggestion against existing themes using word overlap
        // (handles paraphrasing — AI may say "Pragmatic AI Acceptance" vs "Pragmatic Acceptance AI Output Under Constraints")
        const FUZZY_THRESHOLD = 0.45
        const enriched = suggestions.map(s => {
            // 1. Try exact match first
            let match = existingThemes.find(t =>
                t.name.toLowerCase().trim() === s.label.toLowerCase().trim()
            )
            // 2. Fall back to fuzzy word-overlap
            if (!match) {
                let bestScore = 0
                for (const t of existingThemes) {
                    const score = wordSimilarity(s.label, t.name)
                    if (score >= FUZZY_THRESHOLD && score > bestScore) {
                        bestScore = score
                        match = t
                    }
                }
            }
            return {
                ...s,
                // Use exact DB name when fuzzy-matched so the ID is correct
                label: match ? match.name : s.label,
                themeId: match?.id || null,
                isExisting: !!match || s.isExisting,
            }
        })

        // Sort: existing themes first, then new suggestions
        enriched.sort((a, b) => (b.isExisting ? 1 : 0) - (a.isExisting ? 1 : 0))

        return NextResponse.json({ suggestions: enriched, existingThemes })
    } catch (e) {
        console.error('suggest-themes error:', e)
        return NextResponse.json({ error: 'Failed to suggest themes' }, { status: 500 })
    }
}
