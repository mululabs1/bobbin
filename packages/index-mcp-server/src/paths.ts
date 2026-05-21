import { join, normalize, resolve } from 'node:path'

/** Workspace root: editor sets cwd to project root for MCP servers. */
export function getWorkspaceRoot(): string {
  const fromEnv =
    process.env.BOBBIN_WORKSPACE_ROOT ||
    process.env.CURSOR_WORKSPACE ||
    process.env.CLAUDE_WORKSPACE ||
    process.cwd()
  return normalize(resolve(fromEnv))
}

export function getIndexDir(projectPath: string): string {
  const sub = process.env.BOBBIN_INDEX_DIR || '.bobbin/index'
  return join(normalize(resolve(projectPath)), sub)
}

export function isPathInsideRoot(targetPath: string, root: string): boolean {
  const t = normalize(resolve(targetPath))
  const r = normalize(resolve(root))
  return t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')
}
