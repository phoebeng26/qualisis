import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

// POST /api/projects/[projectId]/suggest-themes
// body: { codeLabel: string, excerpt: string }
// Returns 3 theme suggestions — mix of existing themes (if they fit) and new proposals
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

        // Fetch ALL current themes in this project
        const existingThemes = await prisma.theme.findMany({
            where: { projectId: params.projectId },
            select: { id: true, name: true, description: true },
            orderBy: { createdAt: 'asc' }
        })

        const existingList = existingThemes.length > 0
            ? existingThemes.map(t => `• "${t.name}"${t.description ? ` — ${t.description.substring(0, 60)}` : ''}`).join('\n')
            : '(No themes created yet — all suggestions will be new)'

        const rqContext = project?.researchQuestion
            ? `Research Question: ${project.researchQuestion}`
            : ''

        const prompt = `You are an expert qualitative researcher doing thematic analysis.

${rqContext}

A researcher has coded this excerpt with the label: "${codeLabel}"
Excerpt: "${excerpt.substring(0, 300)}"

Current themes already in this project:
${existingList}

Task: Suggest exactly 3 theme options for this code. Rules:
- If an existing theme fits well, REUSE it (include its exact name so it can be matched)
- If no existing theme fits, propose a NEW interpretive theme (not just a description — it should be abstract and theoretically meaningful)
- Make suggestions at different levels of abstraction (one closer to the data, one more theoretical)
- Each theme must relate to the Research Question

Return ONLY a raw JSON array, no markdown:
[
  { "label": "Theme name", "isExisting": true, "reasoning": "One sentence why this code fits this theme" },
  { "label": "Another Theme", "isExisting": false, "reasoning": "One sentence why" },
  { "label": "A Third Option", "isExisting": false, "reasoning": "One sentence why" }
]`

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 400,
        })

        const raw = (response.choices[0].message.content || '[]').trim()
            .replace(/^```json\n?/, '').replace(/```$/, '').trim()

        let suggestions: { label: string; isExisting: boolean; reasoning?: string }[] = []
        try {
            const parsed = JSON.parse(raw)
            suggestions = Array.isArray(parsed) ? parsed : []
        } catch { suggestions = [] }

        // Annotate with themeId if the label matches an existing theme name exactly
        const enriched = suggestions.map(s => {
            const match = existingThemes.find(t => t.name.toLowerCase().trim() === s.label.toLowerCase().trim())
            return {
                ...s,
                themeId: match?.id || null,
                isExisting: !!match || s.isExisting,
            }
        })

        return NextResponse.json({ suggestions: enriched, existingThemes })
    } catch (e) {
        console.error('suggest-themes error:', e)
        return NextResponse.json({ error: 'Failed to suggest themes' }, { status: 500 })
    }
}
