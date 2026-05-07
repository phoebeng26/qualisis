import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { cosineSimilarity } from '@/lib/vector'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    const session = await getServerSession(authOptions)
    if (!session || !session.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const { messages } = await req.json()
        const projectId = params.projectId

        // ── LAYER 1: Structured Project Knowledge ──────────────────────────
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: {
                datasets: {
                    include: {
                        transcripts: {
                            select: { id: true, title: true, status: true }
                        }
                    }
                }
            }
        })
        if (!project) throw new Error('Project not found')

        // Codebook (all codes with definitions)
        const codebook = await prisma.codebookEntry.findMany({
            where: { projectId },
            orderBy: { name: 'asc' }
        })

        // Themes (with descriptions if stored as project-level themes)
        const themes = await prisma.theme.findMany({
            where: { projectId }
        }).catch(() => [] as any[])

        // ── LAYER 2: Transcript Metadata (No raw data) ───────────
        const allTranscripts = await prisma.transcript.findMany({
            where: { dataset: { projectId } },
            select: { id: true, title: true }
        })
        const transcriptsContext = allTranscripts.map(t => `- "${t.title}" (ID: ${t.id})`).join('\n')

        // ── LAYER 3: System Prompt ─────────────────────────────
        const codebookContext = codebook.length > 0
            ? codebook.map(c => `  - ${c.name} (${c.type}): ${c.definition || 'No definition'}`).join('\n')
            : '  No codes created yet.'

        const themesContext = themes.length > 0
            ? themes.map((t: any) => `  - ${t.name}: ${t.description || 'No description'}`).join('\n')
            : '  No themes created yet.'

        const systemPrompt = `You are an expert qualitative research copilot embedded in QualiSIS, a thematic analysis platform.

You are having an ongoing conversation with a researcher working on the project: "${project.name}"
${project.description ? `Project Description: ${project.description}` : ''}

━━━ LAYER 1: PROJECT KNOWLEDGE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CODEBOOK (${codebook.length} codes):
${codebookContext}

THEMES (${themes.length} themes):
${themesContext}

TRANSCRIPTS AVAILABLE:
${transcriptsContext}

━━━ YOUR ROLE & INSTRUCTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You do NOT have the raw transcript data upfront because it is too large. 
Instead, you have tools to retrieve data dynamically:
- \`search_project_data\`: Search for data using codes, exact keywords, or a \`semanticQuery\`. Use \`semanticQuery\` for conceptual searches where exact keywords might not match (Semantic Vector Search).
- \`read_transcript\`: Read the full text of a specific transcript if you need full context or the user asks about a specific file.
Whenever the user asks a question about the data, you MUST use these tools to search or read the relevant evidence BEFORE answering.

1. PROACTIVE COPILOT: Help the researcher find insights. Ask follow-up questions.
2. GROUND IN DATA: When you retrieve data using the tool, always cite specific quotes in your final answer. Format citations EXACTLY as standard Markdown links on a single line pointing to the transcript URL: *"[quote]"* — [Transcript Title](/projects/${projectId}/transcripts/[ID]?quote=[quote_url_encoded])
3. REASON ANALYTICALLY: Synthesize the retrieved data, identify contradictions, and offer interpretive insights.
4. GUARDRAILS FOR "ALL DATA": NEVER try to read all transcripts at once using \`read_transcript\`. If the user asks a broad question about "all data", use \`search_project_data\` to find patterns across the dataset, or politely explain that you cannot read everything simultaneously and ask them to narrow down to specific themes, keywords, or a single transcript.
5. IF NO RESULTS: If your search returns no results, inform the user and suggest trying broader keywords or different codes.`
        
        const latestUserMessage = messages[messages.length - 1]
        
        // Save user message to DB
        await prisma.chatMessage.create({
            data: {
                projectId,
                userId: (session.user as any).id,
                role: 'user',
                content: latestUserMessage.content
            }
        })

        // ── Define Tools for Agentic RAG ───────────────────────────────
        const tools: any = [
            {
                type: 'function',
                function: {
                    name: 'search_project_data',
                    description: 'Search across the project data for specific quotes and coded segments. Use this to find evidence to answer user questions.',
                    parameters: {
                        type: 'object',
                        properties: {
                            codeNames: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Optional. List of exact code names from the codebook to filter by.'
                            },
                            keyword: {
                                type: 'string',
                                description: 'Optional. An exact keyword or phrase to search for within the transcript texts.'
                            },
                            semanticQuery: {
                                type: 'string',
                                description: 'Optional. A conceptual statement or question to perform semantic vector search. Use this to find conceptually similar quotes.'
                            }
                        }
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'read_transcript',
                    description: 'Read the full raw text of a specific transcript. Use this when the user asks you to read or summarize an entire transcript, or if you need full context instead of just snippets. You MUST use the exact transcript ID provided in the TRANSCRIPTS AVAILABLE list.',
                    parameters: {
                        type: 'object',
                        properties: {
                            transcriptId: {
                                type: 'string',
                                description: 'The exact ID of the transcript to read.'
                            }
                        },
                        required: ['transcriptId']
                    }
                }
            }
        ];

        let chatMessages: any[] = [
            { role: 'system', content: systemPrompt },
            ...messages.map((m: any) => ({ role: m.role, content: m.content }))
        ];

        let responseText = '';
        let toolCallCount = 0;
        let toolUsed = false;
        
        // ── Agent Loop ──────────────────────────────────────────────────
        while (toolCallCount < 4) {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                temperature: 0.2,
                messages: chatMessages,
                tools: tools,
                tool_choice: 'auto'
            });

            const responseMessage = completion.choices[0].message;
            chatMessages.push(responseMessage);

            if (responseMessage.tool_calls) {
                toolUsed = true;
                for (const toolCall of responseMessage.tool_calls) {
                    if (toolCall.function.name === 'search_project_data') {
                        const args = JSON.parse(toolCall.function.arguments);
                        let resultsText = '';

                        try {
                            if (args.codeNames && args.codeNames.length > 0) {
                                // Search by Code
                                const segments = await prisma.segment.findMany({
                                    where: {
                                        transcript: { dataset: { projectId } },
                                        codeAssignments: { some: { codebookEntry: { name: { in: args.codeNames } } } }
                                    },
                                    include: { transcript: { select: { title: true } } },
                                    take: 40
                                });
                                resultsText = segments.map(s => `[Transcript: ${s.transcript.title}, ID: ${s.transcriptId}]\nQuote: "${s.text}"`).join('\n\n');
                            } else if (args.semanticQuery) {
                                // Semantic Vector Search
                                const queryEmbeddingResp = await openai.embeddings.create({
                                    model: 'text-embedding-3-small',
                                    input: args.semanticQuery
                                });
                                const queryVector = queryEmbeddingResp.data[0].embedding;

                                const allChunks = await prisma.transcriptChunk.findMany({
                                    where: { transcript: { dataset: { projectId } } },
                                    include: { transcript: { select: { title: true } } }
                                });

                                if (allChunks.length === 0) {
                                    resultsText = "No semantic chunks available. Please advise the user to process Semantic Embeddings for this project first.";
                                } else {
                                    const scoredChunks = allChunks.map(chunk => {
                                        const sim = chunk.embedding ? cosineSimilarity(queryVector, chunk.embedding as number[]) : 0;
                                        return { ...chunk, sim };
                                    });
                                    scoredChunks.sort((a, b) => b.sim - a.sim);
                                    
                                    const topChunks = scoredChunks.slice(0, 15);
                                    resultsText = topChunks.map(c => `[Transcript: ${c.transcript.title}, ID: ${c.transcriptId}] (Relevance: ${c.sim.toFixed(2)})\nQuote: "${c.text}"`).join('\n\n');
                                }
                            } else if (args.keyword) {
                                // Search by Exact Keyword via JS Snippet Extraction
                                const allTranscriptsData = await prisma.transcript.findMany({
                                    where: { dataset: { projectId } },
                                    select: { id: true, title: true, content: true }
                                });
                                const snippets: string[] = [];
                                const keywordLower = args.keyword.toLowerCase();
                                
                                for (const t of allTranscriptsData) {
                                    const lowerContent = t.content.toLowerCase();
                                    let idx = lowerContent.indexOf(keywordLower);
                                    let count = 0;
                                    while (idx !== -1 && count < 6) {
                                        const start = Math.max(0, idx - 150);
                                        const end = Math.min(t.content.length, idx + keywordLower.length + 150);
                                        snippets.push(`[Transcript: ${t.title}, ID: ${t.id}]\nQuote snippet: "...${t.content.substring(start, end).trim()}..."`);
                                        idx = lowerContent.indexOf(keywordLower, idx + keywordLower.length);
                                        count++;
                                    }
                                }
                                resultsText = snippets.slice(0, 40).join('\n\n');
                            }

                            chatMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: resultsText || 'No matching data found.'
                            });
                        } catch (err: any) {
                            chatMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: `Error executing search: ${err.message}`
                            });
                        }
                    } else if (toolCall.function.name === 'read_transcript') {
                        const args = JSON.parse(toolCall.function.arguments);
                        try {
                            const transcript = await prisma.transcript.findUnique({
                                where: { id: args.transcriptId },
                                select: { title: true, content: true }
                            });
                            
                            if (transcript) {
                                // Cap at ~300k chars just in case a single transcript is massively long
                                const safeContent = transcript.content.length > 300000 
                                    ? transcript.content.substring(0, 300000) + '\n[WARNING: Transcript truncated due to size limits]'
                                    : transcript.content;
                                
                                chatMessages.push({
                                    role: 'tool',
                                    tool_call_id: toolCall.id,
                                    content: `[Full Transcript: ${transcript.title}]\n\n${safeContent}`
                                });
                            } else {
                                chatMessages.push({
                                    role: 'tool',
                                    tool_call_id: toolCall.id,
                                    content: 'Transcript not found. Please check the ID.'
                                });
                            }
                        } catch (err: any) {
                            chatMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: `Error reading transcript: ${err.message}`
                            });
                        }
                    }
                }
                toolCallCount++;
            } else {
                responseText = responseMessage.content || 'Sorry, I could not generate a response.';
                break;
            }
        }

        // Save AI response to DB
        await prisma.chatMessage.create({
            data: {
                projectId,
                userId: (session.user as any).id,
                role: 'assistant',
                content: responseText
            }
        })

        return NextResponse.json({ 
            role: 'assistant', 
            content: responseText,
            meta: {
                transcriptsAnalyzed: allTranscripts.length,
                agenticRAG: true,
                toolUsed: toolUsed
            }
        })

    } catch (error: any) {
        console.error('Chat error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

export async function GET(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    const session = await getServerSession(authOptions)
    if (!session || !session.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const messages = await prisma.chatMessage.findMany({
            where: { projectId: params.projectId, userId: (session.user as any).id },
            orderBy: { createdAt: 'asc' }
        })
        
        return NextResponse.json(messages.map(m => ({ role: m.role, content: m.content })))
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: { projectId: string } }
) {
    const session = await getServerSession(authOptions)
    if (!session || !session.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        await prisma.chatMessage.deleteMany({
            where: { projectId: params.projectId, userId: (session.user as any).id }
        })
        return NextResponse.json({ success: true })
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
