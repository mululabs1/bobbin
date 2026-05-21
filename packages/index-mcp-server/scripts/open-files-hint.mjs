#!/usr/bin/env node
/**
 * Optional: when BOBBIN_OPEN_FILES is set in the shell, write the list to
 * .bobbin/open-files.json so the MCP server can pick it up on the next tool call.
 *
 * Export BOBBIN_OPEN_FILES="src/a.ts,src/b.ts" in your shell profile to enable.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const raw = process.env.BOBBIN_OPEN_FILES
if (!raw?.trim()) process.exit(0)

const root = resolve(
  process.env.BOBBIN_WORKSPACE_ROOT ||
    process.env.CURSOR_WORKSPACE ||
    process.env.CLAUDE_WORKSPACE ||
    process.cwd()
)
const files = raw.split(/[,;\n]/).map((f) => f.trim()).filter(Boolean)
const out = join(root, '.bobbin', 'open-files.json')
await mkdir(join(root, '.bobbin'), { recursive: true })
await writeFile(out, JSON.stringify({ files, updatedAt: Date.now() }), 'utf-8')
