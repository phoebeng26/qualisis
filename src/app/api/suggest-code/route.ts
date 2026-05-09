import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { openai } from '@/lib/ai';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

/** Simple word-overlap similarity between query text and a code label. Returns 0–1. */
function semanticSimilarity(queryText: string, codeLabel: string): number {
    const normalize = (s: string) =>
        s.toLowerCase()
         .replace(/[^a-z0-9 ]/g, ' ')
         .split(/\s+/)
         .filter(w => w.length > 2 && !['the','and','that','this','with','for','are','was','were','has','have','been','from','they','their'].includes(w));
    const qWords = new Set(normalize(queryText));
    const cWords = new Set(normalize(codeLabel));
    if (qWords.size === 0 || cWords.size === 0) return 0;
    let intersection = 0;
    cWords.forEach(w => { if (qWords.has(w)) intersection++; });
    // Weighted: jaccard on code side (so short labels don't need huge overlap)
    return intersection / cWords.size;
}

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user ? (session.user as any).id : null;
        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const { text, transcriptContent, projectId } = body;

        if (!text || !projectId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // --- Fetch existing codes & themes from the project codebook ---
        const allThemes = await prisma.theme.findMany({
            where: { projectId },
            include: {
                relationsIn: { where: { relationType: 'SUBTHEME_OF' } },
                relationsOut: { where: { relationType: 'SUBTHEME_OF' } },
                codeLinks: {
                    include: { codebookEntry: true }
                }
            }
        });

        // Reconstruct hierarchy
        const topLevelThemes = allThemes.filter(t => t.relationsOut.length === 0);
        let codebookStructure = "PROJECT CODEBOOK (Themes & Codes):\n";
        
        topLevelThemes.forEach(theme => {
            const childrenIds = theme.relationsIn.map(r => r.sourceId);
            const isMega = childrenIds.length > 0;
            
            if (isMega) {
                codebookStructure += `[Mega Theme] ${theme.name}\n`;
                childrenIds.forEach(subId => {
                    const fullSub = allThemes.find(t => t.id === subId);
                    if (fullSub) {
                        codebookStructure += `  - [Theme] ${fullSub.name}\n`;
                        fullSub.codeLinks?.forEach(link => {
                            codebookStructure += `      * [Code] ${link.codebookEntry.name}\n`;
                        });
                    }
                });
            } else {
                codebookStructure += `[Theme] ${theme.name}\n`;
                theme.codeLinks?.forEach(link => {
                    codebookStructure += `  * [Code] ${link.codebookEntry.name}\n`;
                });
            }
        });

        if (allThemes.length === 0) {
            codebookStructure += "(No themes or codes exist yet)\n";
        }

        // Fetch project to get ontology
        const project = await prisma.project.findUnique({
            where: { id: projectId }
        });

        let projectContext = "";
        if (project?.coreOntology) projectContext += `Core Ontology: ${project.coreOntology}\n`;
        if (project?.researchQuestion) projectContext += `Research Question: ${project.researchQuestion}\n`;

        if (!openai) {
            return NextResponse.json({ 
                suggestions: ["Contextual Code 1", "Contextual Code 2", "Contextual Code 3"],
                existingMatches: []
            });
        }

        const prompt = `You are a specialized Qualitative Researcher.
Your task is to analyze the isolated text snippet below in the context of the full transcript and the project's research question.

${projectContext}

${codebookStructure}

FULL TRANSCRIPT CONTEXT:
"""
${transcriptContent ? transcriptContent.substring(0, 15000) : "Context unavailable."}
"""

ISOLATED TEXT TO CODE:
"${text}"

Based on the conceptual meaning of the text, provide the following in JSON format:
1. "new_codes": An array of EXACTLY 3 highly descriptive, sentence-like new thematic code labels (4-8 words).
2. "existing_codes": An array of up to 3 names of EXISTING [Code] from the PROJECT CODEBOOK above that conceptually match this text. (Leave empty if none match well). Output ONLY the exact code name.
3. "suggested_themes": An array of up to 2 names of EXISTING [Theme] or [Mega Theme] from the PROJECT CODEBOOK above that this text broadly relates to. (Leave empty if none fit).

JSON FORMAT:
{
  "new_codes": ["...", "...", "..."],
  "existing_codes": ["...", "..."],
  "suggested_themes": ["..."]
}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You output JSON only." },
                { role: "user", content: prompt }
            ],
            temperature: 0.4
        });

        const res = JSON.parse(completion.choices[0].message?.content || '{}');
        const suggestions = res.new_codes && Array.isArray(res.new_codes) ? res.new_codes.slice(0,3) : [];
        const existingCodes = res.existing_codes && Array.isArray(res.existing_codes) ? res.existing_codes : [];
        const suggestedThemes = res.suggested_themes && Array.isArray(res.suggested_themes) ? res.suggested_themes : [];

        // Format existing matches for the frontend (they just need an id and name, we mock id for now or fetch it if needed, but frontend just uses name for setting the input)
        const formattedExisting = existingCodes.map((name: string) => ({ id: name, name, definition: null }));
        const formattedThemes = suggestedThemes.map((name: string) => ({ id: name, name, definition: null }));

        return NextResponse.json({ 
            suggestions: suggestions,
            existingMatches: formattedExisting,
            suggestedThemes: formattedThemes
        });

    } catch (e) {
        console.error('Suggest Code Error:', e);
        return NextResponse.json({ suggestions: [], existingMatches: [] }, { status: 500 });
    }
}
