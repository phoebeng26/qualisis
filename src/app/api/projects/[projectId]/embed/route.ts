import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'
import { chunkText } from '@/lib/vector'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

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
        const projectId = params.projectId;
        
        // Find all transcripts for this project
        const transcripts = await prisma.transcript.findMany({
            where: { dataset: { projectId } }
        });

        let totalChunksCreated = 0;

        for (const transcript of transcripts) {
            // Check if it already has chunks
            const existingChunksCount = await prisma.transcriptChunk.count({
                where: { transcriptId: transcript.id }
            });

            if (existingChunksCount === 0) {
                // Generate chunks
                const chunks = chunkText(transcript.content, 800, 150);
                
                // Embed chunks in batches of 100 to avoid API limits
                for (let i = 0; i < chunks.length; i += 100) {
                    const batch = chunks.slice(i, i + 100);
                    const textsToEmbed = batch.map(c => c.text);
                    
                    const embeddingResponse = await openai.embeddings.create({
                        model: 'text-embedding-3-small',
                        input: textsToEmbed
                    });

                    // Save to DB
                    for (let j = 0; j < batch.length; j++) {
                        await prisma.transcriptChunk.create({
                            data: {
                                transcriptId: transcript.id,
                                text: batch[j].text,
                                startIndex: batch[j].startIndex,
                                endIndex: batch[j].endIndex,
                                embedding: embeddingResponse.data[j].embedding
                            }
                        });
                    }
                    totalChunksCreated += batch.length;
                }
            }
        }

        return NextResponse.json({ success: true, chunksCreated: totalChunksCreated });

    } catch (error: any) {
        console.error('Embedding error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
