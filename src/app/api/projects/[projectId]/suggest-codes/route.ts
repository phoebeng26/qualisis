import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
    try {
        const { currentCode, excerpt } = await req.json()
        if (!currentCode || !excerpt) {
            return NextResponse.json({ error: 'currentCode and excerpt required' }, { status: 400 })
        }

        // Fetch project context
        const project = await prisma.project.findUnique({
            where: { id: params.projectId },
            select: { researchQuestion: true, description: true }
        })

        const rqContext = project?.researchQuestion
            ? `Research Question: ${project.researchQuestion}`
            : ''

        const prompt = `You are an expert qualitative researcher doing thematic analysis.

${rqContext}

A researcher is reviewing an AI-suggested code label for the following excerpt. They want alternative code labels to consider.

Excerpt: "${excerpt.substring(0, 500)}"
Current suggested code: "${currentCode}"

Task: Propose exactly 4 alternative code labels for this excerpt.
- They should capture different nuances, actions, emotions, or latent meanings in the text.
- Vary the abstraction level (some descriptive, some more conceptual).
- Keep them concise (1-5 words).
- Make them sound like professional qualitative codes.

Return ONLY a raw JSON array of strings, no markdown fences:
[
  "Alternative Code 1",
  "Alternative Code 2",
  "Alternative Code 3",
  "Alternative Code 4"
]`

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 300,
        })

        const raw = (response.choices[0].message.content || '[]').trim()
            .replace(/^```json\n?/, '').replace(/```$/, '').trim()

        let suggestions: string[] = []
        try {
            const parsed = JSON.parse(raw)
            suggestions = Array.isArray(parsed) ? parsed : []
        } catch { suggestions = [] }

        return NextResponse.json({ alternatives: suggestions })
    } catch (e) {
        console.error('suggest-codes error:', e)
        return NextResponse.json({ error: 'Failed to suggest codes' }, { status: 500 })
    }
}
