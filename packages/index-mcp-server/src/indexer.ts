import { readFile } from 'node:fs/promises'
import { extname, normalize, resolve } from 'node:path'
import fg from 'fast-glob'
import { saveSymbolGraph, SerializedSymbolGraph, SerializedSymbolNode, SymbolType } from './graph-store.js'
import { getIndexDir } from './paths.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Bobbin standalone indexer.
 *
 * v0.1 uses language-specific regex to extract function/class/method/interface/type symbols
 * from TypeScript, JavaScript, Python, Go, Rust, Java, and Ruby files. Callers/callees are
 * inferred by scanning each symbol's body for identifier references to other known symbols.
 *
 * Future versions will swap in tree-sitter parsing for higher accuracy.
 */

const SUPPORTED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
])

const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.bobbin/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/target/**',
  '**/vendor/**',
  '**/*.min.js',
]

interface ExtractedSymbol {
  name: string
  type: SymbolType
  line: number
  endLine: number
  signature?: string
  parent?: string
}

/** Extract symbol definitions from a single file's source text. */
function extractSymbols(filePath: string, source: string): ExtractedSymbol[] {
  const ext = extname(filePath).toLowerCase()
  const lines = source.split(/\r?\n/)
  const out: ExtractedSymbol[] = []

  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    extractJsTs(lines, out)
  } else if (ext === '.py') {
    extractPython(lines, out)
  } else if (ext === '.go') {
    extractGo(lines, out)
  } else if (ext === '.rs') {
    extractRust(lines, out)
  } else if (ext === '.java') {
    extractJava(lines, out)
  } else if (ext === '.rb') {
    extractRuby(lines, out)
  }

  return out
}

function pushSymbol(
  out: ExtractedSymbol[],
  name: string | undefined,
  type: SymbolType,
  line: number,
  signature: string,
  endLine: number,
  parent?: string
) {
  if (!name) return
  out.push({ name, type, line, endLine, signature: signature.trim(), parent })
}

/** Best-effort end-line by tracking braces from `start` forward. */
function findEndLineBrace(lines: string[], start: number): number {
  let depth = 0
  let seenOpen = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        seenOpen = true
      } else if (ch === '}') {
        depth--
        if (seenOpen && depth === 0) return i
      }
    }
  }
  return Math.min(start + 50, lines.length - 1)
}

/** Best-effort end-line for indent-based languages (Python/Ruby). */
function findEndLineIndent(lines: string[], start: number): number {
  const baseIndent = lines[start].search(/\S/)
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const indent = lines[i].search(/\S/)
    if (indent <= baseIndent) return i - 1
  }
  return lines.length - 1
}

function extractJsTs(lines: string[], out: ExtractedSymbol[]) {
  const classStack: Array<{ name: string; endLine: number }> = []

  const fnPatterns: Array<{ re: RegExp; type: SymbolType }> = [
    {
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*[<(]/,
      type: 'function',
    },
    {
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*\(/,
      type: 'function',
    },
    {
      re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?\([^)]*\)\s*=>/,
      type: 'function',
    },
    {
      re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/,
      type: 'function',
    },
  ]

  const classRe = /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
  const interfaceRe = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/
  const typeRe = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/
  const enumRe = /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/
  const methodRe = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+)*([A-Za-z_$][\w$]*)\s*[<(]/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    while (classStack.length && i > classStack[classStack.length - 1].endLine) {
      classStack.pop()
    }

    const classMatch = line.match(classRe)
    if (classMatch) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, classMatch[1], 'class', i + 1, line.trim(), end + 1)
      classStack.push({ name: classMatch[1], endLine: end })
      continue
    }

    const interfaceMatch = line.match(interfaceRe)
    if (interfaceMatch) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, interfaceMatch[1], 'interface', i + 1, line.trim(), end + 1)
      continue
    }

    const typeMatch = line.match(typeRe)
    if (typeMatch) {
      pushSymbol(out, typeMatch[1], 'type', i + 1, line.trim(), i + 1)
      continue
    }

    const enumMatch = line.match(enumRe)
    if (enumMatch) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, enumMatch[1], 'enum', i + 1, line.trim(), end + 1)
      continue
    }

    let matched = false
    for (const { re, type } of fnPatterns) {
      const m = line.match(re)
      if (m && m[1]) {
        const end = line.includes('{') ? findEndLineBrace(lines, i) : i
        pushSymbol(out, m[1], type, i + 1, line.trim(), end + 1)
        matched = true
        break
      }
    }
    if (matched) continue

    if (classStack.length) {
      const m = line.match(methodRe)
      if (m && m[1] && !['if', 'for', 'while', 'switch', 'return', 'catch', 'else', 'do'].includes(m[1])) {
        const parent = classStack[classStack.length - 1].name
        const end = line.includes('{') ? findEndLineBrace(lines, i) : i
        pushSymbol(out, m[1], 'method', i + 1, line.trim(), end + 1, parent)
      }
    }
  }
}

function extractPython(lines: string[], out: ExtractedSymbol[]) {
  const classStack: Array<{ name: string; indent: number; endLine: number }> = []
  const defRe = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/
  const classRe = /^(\s*)class\s+([A-Za-z_][\w]*)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    while (classStack.length && i > classStack[classStack.length - 1].endLine) classStack.pop()

    const c = line.match(classRe)
    if (c) {
      const indent = c[1].length
      const end = findEndLineIndent(lines, i)
      pushSymbol(out, c[2], 'class', i + 1, line.trim(), end + 1)
      classStack.push({ name: c[2], indent, endLine: end })
      continue
    }

    const d = line.match(defRe)
    if (d) {
      const indent = d[1].length
      const end = findEndLineIndent(lines, i)
      const inClass = classStack.find((s) => indent > s.indent)
      pushSymbol(
        out,
        d[2],
        inClass ? 'method' : 'function',
        i + 1,
        line.trim(),
        end + 1,
        inClass?.name
      )
    }
  }
}

function extractGo(lines: string[], out: ExtractedSymbol[]) {
  const funcRe = /^func\s+(?:\(\s*\w+\s+\*?(\w+)\s*\)\s+)?([A-Za-z_][\w]*)\s*\(/
  const typeRe = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface|=|\w)/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = line.match(funcRe)
    if (f) {
      const parent = f[1]
      const name = f[2]
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, name, parent ? 'method' : 'function', i + 1, line.trim(), end + 1, parent)
      continue
    }
    const t = line.match(typeRe)
    if (t) {
      const kind = t[2] === 'struct' ? 'class' : t[2] === 'interface' ? 'interface' : 'type'
      const end = line.includes('{') ? findEndLineBrace(lines, i) : i
      pushSymbol(out, t[1], kind as SymbolType, i + 1, line.trim(), end + 1)
    }
  }
}

function extractRust(lines: string[], out: ExtractedSymbol[]) {
  const fnRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+([A-Za-z_][\w]*)\s*[<(]/
  const structRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/
  const traitRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/
  const enumRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/
  const implRe = /^\s*impl(?:\s*<[^>]+>)?\s+(?:.+?\s+for\s+)?([A-Za-z_][\w]*)/
  let implStack: Array<{ name: string; endLine: number }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    while (implStack.length && i > implStack[implStack.length - 1].endLine) implStack.pop()

    const impl = line.match(implRe)
    if (impl && line.includes('{')) {
      implStack.push({ name: impl[1], endLine: findEndLineBrace(lines, i) })
      continue
    }
    const f = line.match(fnRe)
    if (f) {
      const end = line.includes('{') ? findEndLineBrace(lines, i) : i
      const parent = implStack.length ? implStack[implStack.length - 1].name : undefined
      pushSymbol(out, f[1], parent ? 'method' : 'function', i + 1, line.trim(), end + 1, parent)
      continue
    }
    const s = line.match(structRe)
    if (s) {
      const end = line.includes('{') ? findEndLineBrace(lines, i) : i
      pushSymbol(out, s[1], 'class', i + 1, line.trim(), end + 1)
      continue
    }
    const t = line.match(traitRe)
    if (t) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, t[1], 'interface', i + 1, line.trim(), end + 1)
      continue
    }
    const e = line.match(enumRe)
    if (e) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, e[1], 'enum', i + 1, line.trim(), end + 1)
    }
  }
}

function extractJava(lines: string[], out: ExtractedSymbol[]) {
  const classRe = /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_][\w]*)/
  const interfaceRe = /^\s*(?:public\s+|private\s+)*interface\s+([A-Za-z_][\w]*)/
  const methodRe = /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+)*(?:<[^>]+>\s+)?(?:[\w<>[\],?\s]+)\s+([A-Za-z_][\w]*)\s*\(/
  const classStack: Array<{ name: string; endLine: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    while (classStack.length && i > classStack[classStack.length - 1].endLine) classStack.pop()

    const c = line.match(classRe)
    if (c) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, c[1], 'class', i + 1, line.trim(), end + 1)
      classStack.push({ name: c[1], endLine: end })
      continue
    }
    const inter = line.match(interfaceRe)
    if (inter) {
      const end = findEndLineBrace(lines, i)
      pushSymbol(out, inter[1], 'interface', i + 1, line.trim(), end + 1)
      continue
    }
    if (classStack.length) {
      const m = line.match(methodRe)
      if (m && !['if', 'for', 'while', 'switch', 'return', 'catch', 'new'].includes(m[1])) {
        const end = line.includes('{') ? findEndLineBrace(lines, i) : i
        pushSymbol(
          out,
          m[1],
          'method',
          i + 1,
          line.trim(),
          end + 1,
          classStack[classStack.length - 1].name
        )
      }
    }
  }
}

function extractRuby(lines: string[], out: ExtractedSymbol[]) {
  const classRe = /^\s*class\s+([A-Z][\w:]*)/
  const moduleRe = /^\s*module\s+([A-Z][\w:]*)/
  const defRe = /^\s*def\s+(?:self\.)?([a-z_?!=]+[\w?!=]*)/
  const classStack: Array<{ name: string; endLine: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    while (classStack.length && i > classStack[classStack.length - 1].endLine) classStack.pop()

    const c = line.match(classRe)
    if (c) {
      const end = findEndLineIndent(lines, i)
      pushSymbol(out, c[1], 'class', i + 1, line.trim(), end + 1)
      classStack.push({ name: c[1], endLine: end })
      continue
    }
    const m = line.match(moduleRe)
    if (m) {
      const end = findEndLineIndent(lines, i)
      pushSymbol(out, m[1], 'class', i + 1, line.trim(), end + 1)
      classStack.push({ name: m[1], endLine: end })
      continue
    }
    const d = line.match(defRe)
    if (d) {
      const end = findEndLineIndent(lines, i)
      const parent = classStack.length ? classStack[classStack.length - 1].name : undefined
      pushSymbol(out, d[1], parent ? 'method' : 'function', i + 1, line.trim(), end + 1, parent)
    }
  }
}

const IDENT_RE = /\b([A-Za-z_][\w]*)\b/g

/** Build graph from all extracted symbols. */
async function buildGraph(
  projectPath: string,
  filesWithSymbols: Array<{ file: string; source: string; symbols: ExtractedSymbol[] }>
): Promise<SerializedSymbolGraph> {
  const nodes: SerializedSymbolNode[] = []
  const nameIndex: Record<string, string[]> = {}
  const fileIndex: Record<string, string[]> = {}
  const nameToIds = new Map<string, string[]>()

  for (const { file, symbols } of filesWithSymbols) {
    fileIndex[file] = []
    for (const sym of symbols) {
      const qualifiedName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name
      const id = `${file}:${sym.line}:${sym.name}`
      nodes.push({
        id,
        name: sym.name,
        qualifiedName,
        file,
        line: sym.line,
        endLine: sym.endLine,
        type: sym.type,
        signature: sym.signature,
      })
      ;(nameIndex[sym.name] ||= []).push(id)
      if (sym.name !== qualifiedName) (nameIndex[qualifiedName] ||= []).push(id)
      fileIndex[file].push(id)
      ;(nameToIds.get(sym.name) ?? nameToIds.set(sym.name, []).get(sym.name)!).push(id)
    }
  }

  // Reference scan: build callers/callees via identifier matching inside each symbol's body.
  const callers: Record<string, string[]> = {}
  const callees: Record<string, string[]> = {}

  for (const { file, source, symbols } of filesWithSymbols) {
    const lines = source.split(/\r?\n/)
    for (const sym of symbols) {
      const callerId = `${file}:${sym.line}:${sym.name}`
      const body = lines.slice(sym.line, sym.endLine).join('\n')
      const seen = new Set<string>()
      let m: RegExpExecArray | null
      IDENT_RE.lastIndex = 0
      while ((m = IDENT_RE.exec(body))) {
        const ident = m[1]
        if (ident === sym.name || seen.has(ident)) continue
        seen.add(ident)
        const candidates = nameToIds.get(ident)
        if (!candidates) continue
        for (const calleeId of candidates) {
          if (calleeId === callerId) continue
          ;(callees[callerId] ||= []).push(calleeId)
          ;(callers[calleeId] ||= []).push(callerId)
        }
      }
    }
  }

  return {
    nodes,
    edges: [],
    nameIndex,
    fileIndex,
    callers,
    callees,
  }
}

interface Chunk {
  id: string
  file: string
  content: string
  name?: string
  startLine?: number
  endLine?: number
}

async function writeChunks(projectPath: string, chunks: Chunk[]): Promise<void> {
  const chunksPath = join(getIndexDir(projectPath), 'chunks.json')
  await mkdir(dirname(chunksPath), { recursive: true })
  await writeFile(chunksPath, JSON.stringify({ chunks }, null, 2), 'utf-8')
}

export interface IndexStats {
  files: number
  symbols: number
  callers: number
  callees: number
}

/** Run a full index of the project. */
export async function indexProject(projectPath: string, force = false): Promise<IndexStats> {
  const root = normalize(resolve(projectPath))
  const files = await fg('**/*', {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: IGNORE,
  })

  const filesWithSymbols: Array<{ file: string; source: string; symbols: ExtractedSymbol[] }> = []
  const chunks: Chunk[] = []

  for (const filePath of files) {
    if (!SUPPORTED_EXTS.has(extname(filePath).toLowerCase())) continue
    let source: string
    try {
      source = await readFile(filePath, 'utf-8')
    } catch {
      continue
    }
    if (source.length > 500_000) continue // skip huge files
    const rel = filePath.startsWith(root)
      ? filePath.slice(root.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
      : filePath
    const symbols = extractSymbols(filePath, source)
    if (symbols.length === 0) continue
    filesWithSymbols.push({ file: rel, source, symbols })

    const lines = source.split(/\r?\n/)
    for (const sym of symbols) {
      const body = lines.slice(sym.line - 1, sym.endLine).join('\n')
      chunks.push({
        id: `${rel}:${sym.line}:${sym.name}`,
        file: rel,
        name: sym.name,
        content: body,
        startLine: sym.line,
        endLine: sym.endLine,
      })
    }
  }

  const graph = await buildGraph(root, filesWithSymbols)
  await saveSymbolGraph(root, graph)
  await writeChunks(root, chunks)

  const callerCount = Object.values(graph.callers).reduce((s, a) => s + a.length, 0)
  const calleeCount = Object.values(graph.callees).reduce((s, a) => s + a.length, 0)

  return {
    files: filesWithSymbols.length,
    symbols: graph.nodes.length,
    callers: callerCount,
    callees: calleeCount,
  }
}
