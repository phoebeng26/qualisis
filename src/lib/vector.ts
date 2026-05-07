export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Chunks a text into approximate word chunks, overlapping slightly
export function chunkText(text: string, maxChars: number = 800, overlapChars: number = 100): { text: string; startIndex: number; endIndex: number }[] {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let end = i + maxChars;
        // Try to snap to the nearest space
        if (end < text.length) {
            const nextSpace = text.indexOf(' ', end);
            const prevSpace = text.lastIndexOf(' ', end);
            if (prevSpace > i && end - prevSpace < 50) {
                end = prevSpace;
            } else if (nextSpace !== -1 && nextSpace - end < 50) {
                end = nextSpace;
            }
        } else {
            end = text.length;
        }
        
        chunks.push({
            text: text.substring(i, end).trim(),
            startIndex: i,
            endIndex: end
        });
        
        i = end - overlapChars;
        if (i <= 0 || end >= text.length) break;
    }
    return chunks;
}
