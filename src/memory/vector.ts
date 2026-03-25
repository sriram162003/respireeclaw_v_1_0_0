import { pipeline, env } from '@xenova/transformers';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { MEMORY_DIR } from '../config/loader.js';

env.allowLocalModels = true;
env.useBrowserCache = true;

const DB_PATH = path.join(MEMORY_DIR, 'vectors.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    content     TEXT NOT NULL,
    metadata    TEXT,
    embedding   TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vectors_agent ON vectors(agent_id);
`;

let embeddingPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

async function getEmbedding(text: string): Promise<number[]> {
    if (!embeddingPipeline) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as any;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (embeddingPipeline as any)(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data);
}

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export class VectorMemory {
    private db: Database.Database;

    constructor() {
        if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
        this.db = new Database(DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(SCHEMA);
    }

    async index(agentId: string, content: string, metadata: Record<string, unknown> = {}): Promise<number> {
        const embedding = await getEmbedding(content);
        const stmt = this.db.prepare(
            'INSERT INTO vectors (agent_id, content, metadata, embedding) VALUES (?, ?, ?, ?)'
        );
        const result = stmt.run(agentId, content, JSON.stringify(metadata), JSON.stringify(embedding));
        return result.lastInsertRowid as number;
    }

    async search(agentId: string, query: string, limit = 10): Promise<{ content: string; score: number; metadata: Record<string, unknown> }[]> {
        const queryEmbedding = await getEmbedding(query);
        const rows = this.db.prepare(
            'SELECT id, content, metadata, embedding FROM vectors WHERE agent_id = ?'
        ).all(agentId) as { id: number; content: string; metadata: string; embedding: string }[];

        const results = rows.map(row => ({
            id: row.id,
            content: row.content,
            metadata: JSON.parse(row.metadata || '{}'),
            score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding))
        }));

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit).map(r => ({ content: r.content, score: r.score, metadata: r.metadata }));
    }

    delete(agentId: string): void {
        this.db.prepare('DELETE FROM vectors WHERE agent_id = ?').run(agentId);
    }

    close(): void {
        this.db.close();
    }
}
