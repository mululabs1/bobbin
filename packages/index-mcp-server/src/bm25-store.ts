import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getIndexDir } from './paths.js'

export interface Chunk {
  id: string
  file: string
  content: string
  name?: string
  startLine?: number
  endLine?: number
}

interface ChunkPersisted {
  chunks: Chunk[]
}

/** Simple keyword search over persisted chunks. */
export async function searchChunksLocal(
  projectPath: string,
  query: string,
  topK = 10
): Promise<Array<{ chunk: Chunk; score: number }>> {
  const chunksPath = join(getIndexDir(projectPath), 'chunks.json')
  try {
    const raw = await readFile(chunksPath, 'utf-8')
    const data = JSON.parse(raw) as Chunk[] | ChunkPersisted
    const chunks = Array.isArray(data) ? data : data.chunks ?? []
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1)
    if (!terms.length) return []

    const scored = chunks.map((chunk) => {
      const hay = `${chunk.name ?? ''} ${chunk.content} ${chunk.file}`.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (hay.includes(term)) score += 1
      }
      return { chunk, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  } catch {
    return []
  }
}
