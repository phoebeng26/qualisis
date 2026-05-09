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

        // --- Fetch existing codes from the project codebook ---
        const existingCodesRaw = await prisma.codebookEntry.findMany({
            where: { projectId },
            select: { id: true, name: true, definition: true },
            orderBy: { name: 'asc' }
        });

        // Score each existing code against the selected text
        const SIMILARITY_THRESHOLD = 0.35; // ~35% word overlap
        const matchingCodes = existingCodesRaw
            .map(c => ({ id: c.id, name: c.name, definition: c.definition, score: semanticSimilarity(text, c.name) }))
            .filter(c => c.score >= SIMILARITY_THRESHOLD)
            .sort((a, b) => b.score - a.score)
            .slice(0, 4);

        // Fetch project to get ontology
        const project = await prisma.project.findUnique({
            where: { id: projectId }
        });

        // Get the latest few human code assignments from this project to build few-shot examples
        const recentAssignments = await prisma.codeAssignment.findMany({
            where: {
                segment: { transcript: { dataset: { projectId } } }
            },
            take: 5,
            orderBy: { createdAt: 'desc' },
            include: { segment: true, codebookEntry: true }
        });

        const historyContextText = recentAssignments.length > 0
            ? "Recent codes applied by this researcher:\n" + recentAssignments.map(a => `- Text: "${a.segment.text}" => Code: "${a.codebookEntry.name}"`).join('\n')
            : "No previous codes in this project yet.";

        let projectContext = "";
        if (project?.coreOntology) projectContext += `Core Ontology: ${project.coreOntology}\n`;
        if (project?.researchQuestion) projectContext += `Research Question: ${project.researchQuestion}\n`;

        if (!openai) {
            return NextResponse.json({ 
                suggestions: ["Contextual Code 1", "Contextual Code 2", "Contextual Code 3"],
                existingMatches: matchingCodes
            });
        }

        const prompt = `You are a specialized Qualitative Researcher.
Your task is to suggest EXACTLY 3 highly descriptive, sentence-like thematic code labels (4-8 words) for the isolated text snippet below.
CRUCIAL: You are provided with the full transcript context. Read the surrounding context to deeply understand what the isolated snippet actually means in context before suggesting codes. Do NOT reduce the label to basic 1-2 word tags.

${projectContext}
${historyContextText}

FULL TRANSCRIPT CONTEXT:
"""
${transcriptContent ? transcriptContent.substring(0, 15000) : "Context unavailable."}
"""

ISOLATED TEXT TO CODE:
"${text}"

Output your suggestions as a JSON array of 3 strings: { "suggestions": ["Descriptive Label 1", "Descriptive Label 2", "Descriptive Label 3"] }`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You output JSON only." },
                { role: "user", content: prompt }
            ],
            temperature: 0.4
        });

        const res = JSON.parse(completion.choices[0].message?.content || '{"suggestions": []}');
        const suggestions = res.suggestions && Array.isArray(res.suggestions) ? res.suggestions : [];

        return NextResponse.json({ 
            suggestions: suggestions.slice(0, 3),
            existingMatches: matchingCodes
        });

    } catch (e) {
        console.error('Suggest Code Error:', e);
        return NextResponse.json({ suggestions: [], existingMatches: [] }, { status: 500 });
    }
}
