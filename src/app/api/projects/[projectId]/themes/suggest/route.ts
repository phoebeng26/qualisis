export const maxDuration = 60; // Max allowed for Vercel Hobby
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { openai } from '@/lib/ai'

// Batch size: how many codes to send per AI call to avoid context-window limits.
// We increase this to 2000 to allow the AI to see ALL unassigned codes at once for a holistic analysis.
const MAX_CODES_PER_BATCH = 100

// POST /api/projects/[projectId]/themes/suggest — AI suggests theme groupings
export async function POST(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    try {
        const body = await req.json().catch(() => ({}))
        const { customPrompt, rejectedNames, batchOffset = 0 } = body || {}

        // 1. Get all codebook entries for this project
        const codebookEntries = await prisma.codebookEntry.findMany({
            where: { projectId: params.projectId },
            include: {
                codeAssignments: {
                    include: {
                        segment: { select: { text: true, transcriptId: true } },
                        aiSuggestion: { select: { uncertainty: true } }
                    },
                    take: 3 // limit examples per code to keep prompt compact
                },
                _count: { select: { codeAssignments: true } },
                // Include themeLinks with theme status to correctly identify unassigned codes
                themeLinks: {
                    include: {
                        theme: { select: { status: true } }
                    }
                }
            }
        })

        if (codebookEntries.length === 0) {
            return NextResponse.json({ suggestions: [], message: 'No codes found in this project' })
        }

        // 2. Keep only truly unassigned codes:
        //    - Has at least 1 segment assignment (normal codes),
        //      OR is an OBSERVATION code (researcher notes — 0 assignments by design),
        //      OR has 0 assignments but was explicitly entered by the researcher (RAW/CLEAN type)
        //    - Not actively linked to any NON-MERGED theme
        //      (codes whose only theme links are to MERGED themes can be re-grouped)
        const allUnassigned = codebookEntries
            .filter(c => c.type === 'OBSERVATION' || c._count.codeAssignments > 0)
            .filter(c =>
                !c.themeLinks.some((tl: any) => tl.theme.status !== 'MERGED')
            )
            // Sort: observations last (no instances), then by most-used first
            .sort((a, b) => b._count.codeAssignments - a._count.codeAssignments)

        if (allUnassigned.length < 2) {
            // Debug log to help diagnose issues
            const totalCodes = codebookEntries.length
            const alreadyInTheme = codebookEntries.filter(c => c.themeLinks.some((tl: any) => tl.theme.status !== 'MERGED')).length
            console.log(`[Suggest] ${totalCodes} total codes | ${alreadyInTheme} already in active themes | ${allUnassigned.length} unassigned → NOT ENOUGH`)
            return NextResponse.json({
                suggestions: [],
                message: `Need at least 2 unassigned codes to generate theme suggestions (found ${allUnassigned.length} — ${alreadyInTheme} codes are still linked to existing themes)`
            })
        }

        console.log(`[Suggest] Generating suggestions for ${allUnassigned.length} unassigned codes (offset=${batchOffset})`)

        // 3. Slice the batch for this request
        const batchStart = batchOffset
        const batchCodes = allUnassigned.slice(batchStart, batchStart + MAX_CODES_PER_BATCH)
        const remainingAfterBatch = Math.max(0, allUnassigned.length - (batchStart + MAX_CODES_PER_BATCH))

        // Build a CONCISE code list (skip full example quotes for large batches to save tokens)
        const useLongFormat = batchCodes.length <= 30

        // Map raw DB type to human-readable label for the AI prompt
        const humanReadableType = (code: any): string => {
            if (code.type === 'OBSERVATION') return 'Researcher Observation'
            if (code._count.codeAssignments === 0) return 'Human Created (no instances yet)'
            // Check if any assignment has an AI suggestion
            const hasAI = code.codeAssignments.some((a: any) => a.aiSuggestion)
            return hasAI ? 'AI-Assisted' : 'Human Created'
        }

        const codesSummary = batchCodes.map((code, idx) => {
            const includeExamples = batchCodes.length <= 40
            const examples = includeExamples ? code.codeAssignments
                .slice(0, 1)
                .map((a: any) => `"${a.segment.text.slice(0, 100)}"`)
                .join('; ') : ''
            return `${idx + 1}. "${code.name}" (${code._count.codeAssignments}× used)${
                code.definition ? ` — ${(code.definition as string).slice(0, 100)}` : ''
            }${examples ? `\n   e.g. ${examples}` : ''}`
        }).join('\n')

        // 4. Get project context and existing themes
        const [project, existingThemes] = await Promise.all([
            prisma.project.findUnique({
                where: { id: params.projectId },
                select: { name: true, description: true, researchQuestion: true }
            }),
            prisma.theme.findMany({
                where: { projectId: params.projectId, status: { not: 'MERGED' } },
                select: { name: true, description: true }
            })
        ])

        const existingThemesSummary = existingThemes.length > 0
            ? existingThemes.map((t: any) => `- "${t.name}": ${t.description || 'No description'}`).join('\n')
            : 'None yet.'

        const userInstructions = (customPrompt as string | undefined)?.trim() || ''

        const prompt = `You are a senior qualitative researcher performing Reflexive Thematic Analysis (Phase 3: Searching for Themes).

Project: "${project?.name || 'Research Project'}"
${project?.researchQuestion ? `Research Question: "${project.researchQuestion}"` : ''}

EXISTING THEMES (do NOT recreate; only reuse exact name if a code clearly fits there):
${existingThemesSummary}

Below is the COMPLETE list of ${batchCodes.length} unassigned codes you MUST work with:
${codesSummary}

YOUR TASK:
Group the codes above into a set of overarching themes (aim for 4–12) that directly address the Research Question and any Extra Instructions. You MUST attempt to assign EVERY code to a theme.

RULES (follow strictly):
1. LENS OF THE RESEARCH QUESTION: You MUST interpret the latent meaning of the codes through the lens of the Research Question and the "EXTRA INSTRUCTIONS". Do NOT just group words that sound similar (Topic clustering). Group codes by how they jointly answer the core research problem.
2. DECLARATIVE SENTENCE NAMES: A theme is NOT a bucket. The theme name MUST be a complete, declarative sentence that expresses a core finding or insight (e.g., "Users distrust AI because its decision-making process is opaque"). NEVER use generic topics or jargon like "Technical Issues", "User Feedback", "Dynamics of...", or "Patterns in...".
3. EXHAUSTIVE COVERAGE: EVERY code in the numbered list above must appear in your output. Do not skip any code. If a code does not fit neatly, create a broad residual theme (e.g., "Other emerging patterns") to capture it.
4. HOLISTIC GROUPING: Think about the big picture first. Prefer fewer, broader themes over many narrow micro-themes. Merge similar codes into the same theme.
5. MUTUALLY EXCLUSIVE: Each theme must address a distinctly different phenomenon. No conceptual overlap between themes.
6. Each code may appear in AT MOST ONE theme.
7. Minimum 2 codes per theme. No upper limit.
8. If a code clearly belongs to an existing theme, use that EXACT existing theme name.
9. "Researcher Observation" and "Human Created" codes are EQUALLY VALID — treat them the same as AI-Assisted codes.
${Array.isArray(rejectedNames) && rejectedNames.length > 0 ? `10. REJECTED — DO NOT use or recreate: ${(rejectedNames as string[]).map((n: string) => `"${n}"`).join(', ')}` : ''}
${userInstructions ? `${Array.isArray(rejectedNames) && rejectedNames.length > 0 ? '11' : '10'}. EXTRA INSTRUCTIONS (Highest Priority): ${userInstructions}` : ''}

Before outputting, verify: have you included ALL ${batchCodes.length} codes? Is every theme name a full sentence?

Return ONLY a JSON array (no markdown, no explanation). Crucially, to save space, output the CODE NUMBERS (the index from the list above) in "codeIndexes", NOT the names:
[
  {
    "name": "Theme name",
    "description": "2-3 sentences: what exactly is this theme about and how it answers the Research Question?",
    "reason": "Why are these specific codes grouped together?",
    "confidenceScore": 85,
    "codeIndexes": [1, 4, 15, 23]
  }
]`

        // 5. Call AI
        if (!openai) {
            return NextResponse.json({
                suggestions: generateFallbackSuggestions(batchCodes),
                source: 'heuristic',
                totalUnassigned: allUnassigned.length,
                batchOffset: batchStart,
                remainingAfterBatch
            })
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0.2,
            max_tokens: 8000,
            messages: [{ role: 'user', content: prompt }],
        })

        const raw = response.choices[0]?.message?.content ?? '[]'
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

        try {
            const suggestions = JSON.parse(cleaned)

            // Map code numbers back to IDs using the batch codes
            const enriched = suggestions.map((s: any) => {
                // Determine which indices to use
                const indices = s.codeIndexes && Array.isArray(s.codeIndexes) ? s.codeIndexes : [];
                
                // For safety, if AI somehow still outputs codeNames, parse them using old method
                let mappedCodes: any[] = [];
                if (indices.length > 0) {
                    mappedCodes = indices.map((idx: number) => {
                        const entry = batchCodes[idx - 1]; // 1-indexed in prompt
                        return entry ? { id: entry.id, name: entry.name, instances: entry._count.codeAssignments, type: entry.type } : null;
                    }).filter(Boolean);
                } else if (s.codeNames && Array.isArray(s.codeNames)) {
                    mappedCodes = Array.from(new Map(s.codeNames.map((name: string) => {
                        const cleanName = name.trim().toLowerCase();
                        let entry = batchCodes.find((c: any) => c.name.toLowerCase() === cleanName)
                        if (!entry) entry = batchCodes.find((c: any) =>
                            c.name.toLowerCase().includes(cleanName) || cleanName.includes(c.name.toLowerCase())
                        )
                        if (!entry) {
                            const queryWords = cleanName.split(/\s+/).filter((w: string) => w.length > 3)
                            entry = batchCodes.find((c: any) => {
                                const cWords = c.name.toLowerCase().split(/\s+/)
                                return queryWords.some((w: string) => cWords.includes(w))
                            })
                        }
                        return entry ? [entry.id, { id: entry.id, name: entry.name, instances: entry._count.codeAssignments, type: entry.type }] : null
                    }).filter(Boolean)).values());
                }

                return {
                    ...s,
                    reason: s.reason || null,
                    confidenceScore: typeof s.confidenceScore === 'number' ? s.confidenceScore : null,
                    connections: s.connections || null,
                    codes: mappedCodes
                };
            });

            let finalSuggestions: any[] = enriched.filter((s: any) => s.codes?.length >= 2)

            // Calculate how many codes were actually covered
            const assignedIds = new Set<string>(
                finalSuggestions.flatMap((s: any) => s.codes.map((c: any) => c.id))
            )
            const missedCodes = batchCodes.filter((c: any) => !assignedIds.has(c.id))

            console.log(`[Suggest] ${finalSuggestions.length} themes | ${batchCodes.length - missedCodes.length} codes covered | ${missedCodes.length} skipped by AI`)

            // If AI is too strict/lazy and returns nothing at all, fallback to heuristic
            if (finalSuggestions.length === 0) {
                console.log('AI returned 0 suggestions, using heuristic fallback')
                finalSuggestions = generateFallbackSuggestions(batchCodes)
            }

            return NextResponse.json({
                suggestions: finalSuggestions,
                source: 'ai',
                totalUnassigned: allUnassigned.length,
                batchOffset: batchStart,
                batchSize: batchCodes.length,
                remainingAfterBatch
            })
        } catch (parseErr: any) {
            console.error('Failed to parse AI suggestions:', parseErr, '\nRaw:', raw.slice(0, 500))
            return NextResponse.json({
                suggestions: generateFallbackSuggestions(batchCodes),
                source: 'heuristic',
                totalUnassigned: allUnassigned.length,
                batchOffset: batchStart,
                remainingAfterBatch
            })
        }

    } catch (e: any) {
        console.error('Theme suggestion error:', e)
        return NextResponse.json({ error: 'Failed to generate suggestions', details: e.message || String(e) }, { status: 500 })
    }
}

// Simple heuristic-based fallback when no AI is available
function generateFallbackSuggestions(codes: any[]) {
    const suggestions: any[] = []
    const used = new Set<string>()

    for (let i = 0; i < codes.length; i++) {
        if (used.has(codes[i].id)) continue
        const group = [codes[i]]
        const words1 = new Set(codes[i].name.toLowerCase().split(/\s+/))

        for (let j = i + 1; j < codes.length; j++) {
            if (used.has(codes[j].id)) continue
            const words2 = new Set(codes[j].name.toLowerCase().split(/\s+/))
            const overlap = Array.from(words1).filter(w => words2.has(w as string) && (w as string).length > 3).length
            const def1 = (codes[i].definition || '').toLowerCase()
            const def2 = (codes[j].definition || '').toLowerCase()
            const defOverlap = def1 && def2 &&
                def1.split(/\s+/).filter((w: string) => def2.includes(w) && w.length > 4).length > 2
            if (overlap > 0 || defOverlap) group.push(codes[j])
        }

        if (group.length >= 2) {
            group.forEach(g => used.add(g.id))
            suggestions.push({
                name: `Theme: ${group[0].name.split(' ')[0]}`,
                tags: ['Auto-grouped'],
                description: `These ${group.length} codes share semantic similarities and may form a coherent theme.`,
                codes: group.map((g: any) => ({
                    id: g.id,
                    name: g.name,
                    instances: g._count.codeAssignments,
                    type: g.type
                }))
            })
        }
    }

    // Force a "Miscellaneous" group if both AI and heuristics fail to find any matches
    // This prevents the user from being stuck with a few ungroupable 'leftover' codes and a seemingly dead 'Generate' button.
    const remainingUngrouped = codes.filter((c: any) => !used.has(c.id))
    if (suggestions.length === 0 && remainingUngrouped.length > 0) {
        suggestions.push({
            name: "Other Insights",
            tags: ["Miscellaneous"],
            description: "These remaining codes do not share obvious patterns and have been grouped together to complete the review.",
            codes: remainingUngrouped.map((g: any) => ({
                id: g.id,
                name: g.name,
                instances: g._count.codeAssignments,
                type: g.type
            }))
        })
    }

    return suggestions
}
