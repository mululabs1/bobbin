import { readFile } from 'node:fs/promises'
import { normalize, resolve } from 'node:path'
import fg from 'fast-glob'

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.bobbin/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
]

export interface GrepOptions {
  pattern: string
  path?: string
  glob?: string
  outputMode?: 'content' | 'files_with_matches' | 'count'
  caseInsensitive?: boolean
  maxResults?: number
}

export interface GrepMatch {
  file: string
  line?: number
  content?: string
}

export async function grepSearch(
  workspaceRoot: string,
  options: GrepOptions
): Promise<{ results: GrepMatch[]; error?: string }> {
  const maxResults = Math.min(options.maxResults ?? 100, 500)
  const searchRoot = normalize(resolve(workspaceRoot, options.path || '.'))
  const pattern = options.pattern
  if (!pattern?.trim()) {
    return { results: [], error: 'pattern is required' }
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern, options.caseInsensitive ? 'i' : '')
  } catch {
    regex = new RegExp(
      pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      options.caseInsensitive ? 'i' : ''
    )
  }

  const globPattern = options.glob || '**/*'
  const files = await fg(globPattern, {
    cwd: searchRoot,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: DEFAULT_IGNORE,
  })

  const outputMode = options.outputMode ?? 'files_with_matches'
  const results: GrepMatch[] = []

  for (const filePath of files) {
    if (results.length >= maxResults) break
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    const rel = filePath.startsWith(workspaceRoot)
      ? filePath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
      : filePath

    if (outputMode === 'files_with_matches') {
      if (lines.some((line) => regex.test(line))) {
        results.push({ file: rel })
      }
      continue
    }

    if (outputMode === 'count') {
      let count = 0
      for (const line of lines) {
        if (regex.test(line)) count++
      }
      if (count > 0) results.push({ file: rel, content: String(count) })
      continue
    }

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break
      if (regex.test(lines[i])) {
        results.push({ file: rel, line: i + 1, content: lines[i].trimEnd() })
      }
    }
  }

  return { results }
}

export async function globSearch(
  workspaceRoot: string,
  pattern: string,
  cwd?: string
): Promise<string[]> {
  const searchRoot = normalize(resolve(workspaceRoot, cwd || '.'))
  const paths = await fg(pattern, {
    cwd: searchRoot,
    onlyFiles: true,
    dot: false,
    ignore: DEFAULT_IGNORE,
  })
  return paths
}
