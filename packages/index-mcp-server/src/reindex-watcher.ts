import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getWorkspaceRoot } from './paths.js'

let lastSeen = 0

export async function checkReindexFlag(): Promise<boolean> {
  const flag = join(getWorkspaceRoot(), '.bobbin', '.reindex-pending')
  try {
    const raw = await readFile(flag, 'utf-8')
    const ts = Number(raw)
    if (ts > lastSeen) {
      lastSeen = ts
      return true
    }
  } catch {
    /* no flag */
  }
  return false
}
