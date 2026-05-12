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
        const { codeLabel, excerpt, segmentId, isMegaThemeRequest } = await req.json()
        if (!codeLabel || !excerpt) {
            return NextResponse.json({ error: 'codeLabel and excerpt required' }, { status: 400 })
        }

        // Fetch researcher memo if segmentId is provided
        let researcherMemo = ''
        if (segmentId) {
            const segment = await prisma.segment.findUnique({
                where: { id: segmentId },
                include: {
                    suggestions: {
                        orderBy: { confidence: 'desc' },
                        take: 1,
                        include: { reviewDecision: true }
                    }
                }
            })
            if (segment && segment.suggestions.length > 0) {
                researcherMemo = segment.suggestions[0].reviewDecision?.note || ''
            }
        }

        // Fetch project context
        const project = await prisma.project.findUnique({
            where: { id: params.projectId },
            select: { researchQuestion: true, description: true }
        })

        // Fetch ALL current themes WITH their existing code links and relations for richer AI context
        const existingThemes = await prisma.theme.findMany({
            where: { projectId: params.projectId, status: { not: 'MERGED' } },
            select: {
                id: true,
                name: true,
                description: true,
                codeLinks: {
                    select: {
                        codebookEntry: { select: { name: true } }
                    },
                    take: 8  // show up to 8 sample codes per theme
                },
                relationsIn: {
                    where: { relationType: 'SUBTHEME_OF' },
                    select: { source: { select: { name: true } } }
                },
                relationsOut: {
                    where: { relationType: 'SUBTHEME_OF' },
                    select: { targetId: true }
                }
            },
            orderBy: { createdAt: 'asc' }
        })

        const rqContext = project?.researchQuestion
            ? `Research Question: ${project.researchQuestion}`
            : ''

        // Build rich theme descriptions including sub-themes and codes
        const existingList = existingThemes.length > 0
            ? existingThemes.map(t => {
                const isMega = t.relationsIn.length > 0;
                const typeLabel = isMega ? 'MEGA THEME' : 'THEME';
                const subThemes = isMega ? t.relationsIn.map(r => `"${r.source.name}"`).join(', ') : '';
                const codeNames = t.codeLinks.map(l => `"${l.codebookEntry.name}"`).join(', ')
                
                const contextArr = [];
                if (subThemes) contextArr.push(`Contains Sub-themes: ${subThemes}`);
                if (codeNames) contextArr.push(`Contains Codes: ${codeNames}`);
                
                const contextStr = contextArr.length > 0 ? `\n     ${contextArr.join(' | ')}` : '';
                const descContext = t.description ? `\n     Description: ${t.description.substring(0, 80)}` : ''
                
                return `• ${typeLabel}: "${t.name}"${descContext}${contextStr}`
            }).join('\n\n')
            : '(No themes created yet — all suggestions will be new)'

        let prompt = '';
        if (isMegaThemeRequest) {
            prompt = `You are an expert qualitative researcher doing thematic analysis.

${rqContext}

A researcher has assigned the Theme: "${codeLabel}"
Excerpt supporting this theme: "${excerpt.substring(0, 300)}"
${researcherMemo ? `Researcher Memo: "${researcherMemo}"` : ''}

Current themes already in this project (some may already be Mega Themes):
${existingList}

Task: Suggest exactly 3 MEGA THEMES (higher-level abstraction/parent themes) for this Theme. Prioritize semantic fit with the overarching Research Question:

1. FIRST check existing themes — if one acts as a good Mega Theme/umbrella for "${codeLabel}", REUSE it. Copy its exact name.
2. If no existing theme fits well as a broad umbrella, propose a NEW Mega Theme. It must be a broad, high-level structural theme (e.g., matching a section of a final report).
3. Vary abstraction levels across the 3 suggestions.

Return ONLY a raw JSON array, no markdown fences:
[
  { "label": "Exact existing theme name OR new name", "isExisting": true, "reasoning": "One sentence explaining the semantic fit" },
  { "label": "Another option", "isExisting": false, "reasoning": "One sentence why" },
  { "label": "Third option", "isExisting": false, "reasoning": "One sentence why" }
]`
        } else {
            prompt = `You are an expert qualitative researcher doing thematic analysis.

${rqContext}

A researcher has coded this excerpt with the label: "${codeLabel}"
Excerpt: "${excerpt.substring(0, 300)}"
${researcherMemo ? `Researcher Memo: "${researcherMemo}"` : ''}

Current themes already in this project (with their existing codes):
${existingList}

Task: Suggest exactly 3 theme options for this code. Prioritize semantic fit:

1. CRITICAL: FIRST check each existing theme — look at its name AND the codes already inside it. If "${codeLabel}" belongs conceptually with those codes, YOU MUST REUSE THAT THEME. Do not create a new theme if an existing one is a 70%+ conceptual match. Copy its EXACT name.
2. If, and ONLY if, no existing theme fits well, propose a NEW interpretive theme.
3. Provide a mix of existing (if applicable) and new options. At least your first option should be an existing theme if one is even remotely relevant.

Return ONLY a raw JSON array, no markdown fences:
[
  { "label": "Exact existing theme name OR new name", "isExisting": true, "reasoning": "One sentence explaining the semantic fit" },
  { "label": "Another option", "isExisting": false, "reasoning": "One sentence why" },
  { "label": "Third option", "isExisting": false, "reasoning": "One sentence why" }
]`
        }

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
        let exactDbMatch: { label: string; isExisting: boolean; reasoning: string; themeId: string } | null = null;

        // --- NEW: Check database for existing exact relationships before relying purely on AI ---
        if (isMegaThemeRequest) {
            // Child is a Theme. Find if this Theme exists and has a Mega-theme.
            const matchedTheme = existingThemes.find(t => t.name.toLowerCase().trim() === codeLabel.toLowerCase().trim());
            if (matchedTheme && matchedTheme.relationsOut.length > 0) {
                const megaThemeId = matchedTheme.relationsOut[0].targetId;
                const megaTheme = existingThemes.find(t => t.id === megaThemeId);
                if (megaTheme) {
                    exactDbMatch = {
                        label: megaTheme.name,
                        isExisting: true,
                        reasoning: "Exact match: You have already assigned this Theme to this Mega-Theme in the project.",
                        themeId: megaTheme.id
                    };
                }
            }
        } else {
            // Child is a Code. Find if this Code exists in the DB and is linked to a Theme.
            const existingCode = await prisma.codebookEntry.findFirst({
                where: { projectId: params.projectId, name: { equals: codeLabel, mode: 'insensitive' } },
                include: { themeLinks: { include: { theme: true } } }
            });
            if (existingCode && existingCode.themeLinks.length > 0) {
                const linkedTheme = existingCode.themeLinks[0].theme;
                if (linkedTheme.status !== 'MERGED') {
                    exactDbMatch = {
                        label: linkedTheme.name,
                        isExisting: true,
                        reasoning: "Exact match: This code is already grouped under this Theme in your Codebook.",
                        themeId: linkedTheme.id
                    };
                }
            }
        }

        try {
            const parsed = JSON.parse(raw)
            suggestions = Array.isArray(parsed) ? parsed : []
        } catch { suggestions = [] }

        // If we found an exact DB match, force it to be the first suggestion and remove duplicates from AI
        if (exactDbMatch) {
            suggestions = suggestions.filter(s => s.label.toLowerCase().trim() !== exactDbMatch!.label.toLowerCase().trim());
            suggestions.unshift(exactDbMatch);
        }

        // Fuzzy-match each suggestion against existing themes using word overlap
        // (handles paraphrasing — AI may say "Pragmatic AI Acceptance" vs "Pragmatic Acceptance AI Output Under Constraints")
        const FUZZY_THRESHOLD = 0.5  // Raised threshold — only confident matches count
        const seenThemeIds = new Set<string>()

        const enriched = suggestions
            .map(s => {
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

                // IMPORTANT: isExisting is determined PURELY by DB match — ignore AI's self-report
                // This prevents false "existing" labels when the AI hallucinates or paraphrases
                const isExistingConfirmed = !!match

                return {
                    ...s,
                    label: match ? match.name : s.label,  // Use exact DB name if matched
                    themeId: match?.id || null,
                    isExisting: isExistingConfirmed,
                    _matchId: match?.id || null,  // for deduplication
                }
            })
            // Deduplicate: if two suggestions matched the same existing theme, keep only the first
            .filter(s => {
                if (s._matchId) {
                    if (seenThemeIds.has(s._matchId)) return false
                    seenThemeIds.add(s._matchId)
                }
                return true
            })
            .map(({ _matchId, ...rest }) => rest)  // remove internal dedup field

        // Sort: confirmed existing themes first, then new proposals
        enriched.sort((a, b) => (b.isExisting ? 1 : 0) - (a.isExisting ? 1 : 0))

        return NextResponse.json({ suggestions: enriched, existingThemes })
    } catch (e) {
        console.error('suggest-themes error:', e)
        return NextResponse.json({ error: 'Failed to suggest themes' }, { status: 500 })
    }
}
