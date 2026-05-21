#!/usr/bin/env node
/**
 * Debounced re-index signal for editor hooks (FileChanged).
 * Writes a timestamp; MCP server picks it up on next tool call.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(
  process.env.BOBBIN_WORKSPACE_ROOT ||
    process.env.CURSOR_WORKSPACE ||
    process.env.CLAUDE_WORKSPACE ||
    process.cwd()
)
const flagDir = join(root, '.bobbin')
const flagFile = join(flagDir, '.reindex-pending')

await mkdir(flagDir, { recursive: true })
await writeFile(flagFile, String(Date.now()), 'utf-8')
