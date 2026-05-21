import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getIndexDir } from './paths.js'

export type SymbolType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'property'

export interface SerializedSymbolNode {
  id: string
  name: string
  qualifiedName: string
  file: string
  line: number
  endLine: number
  type: SymbolType
  signature?: string
}

export interface SerializedSymbolGraph {
  nodes: SerializedSymbolNode[]
  edges: Array<{ from: string; to: string; type: string }>
  nameIndex: Record<string, string[]>
  fileIndex: Record<string, string[]>
  callers: Record<string, string[]>
  callees: Record<string, string[]>
}

export interface SymbolGraphLoaded {
  nodes: Map<string, SerializedSymbolNode>
  nameIndex: Map<string, string[]>
  fileIndex: Map<string, string[]>
  callers: Map<string, Set<string>>
  callees: Map<string, Set<string>>
}

export async function loadSymbolGraph(projectPath: string): Promise<SymbolGraphLoaded | null> {
  const graphPath = join(getIndexDir(projectPath), 'symbolGraph.json')
  try {
    const raw = await readFile(graphPath, 'utf-8')
    const data = JSON.parse(raw) as SerializedSymbolGraph
    return deserialize(data)
  } catch {
    return null
  }
}

export async function saveSymbolGraph(
  projectPath: string,
  graph: SerializedSymbolGraph
): Promise<void> {
  const graphPath = join(getIndexDir(projectPath), 'symbolGraph.json')
  await mkdir(dirname(graphPath), { recursive: true })
  await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf-8')
}

function deserialize(data: SerializedSymbolGraph): SymbolGraphLoaded {
  const nodes = new Map<string, SerializedSymbolNode>()
  for (const n of data.nodes) nodes.set(n.id, n)

  const nameIndex = new Map<string, string[]>(Object.entries(data.nameIndex || {}))
  const fileIndex = new Map<string, string[]>(Object.entries(data.fileIndex || {}))
  const callers = new Map<string, Set<string>>()
  const callees = new Map<string, Set<string>>()

  for (const [id, list] of Object.entries(data.callers || {})) {
    callers.set(id, new Set(list))
  }
  for (const [id, list] of Object.entries(data.callees || {})) {
    callees.set(id, new Set(list))
  }

  return { nodes, nameIndex, fileIndex, callers, callees }
}

function resolveSymbolId(graph: SymbolGraphLoaded, ref: string): string | null {
  if (graph.nodes.has(ref)) return ref
  const candidates = graph.nameIndex.get(ref) || []
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    const exact = candidates.find((id) => id.endsWith(`:${ref}`) || id.includes(ref))
    return exact ?? candidates[0]
  }
  for (const [id, node] of graph.nodes) {
    if (node.qualifiedName === ref || node.name === ref) return id
  }
  return null
}

export function findSymbol(
  graph: SymbolGraphLoaded,
  name: string,
  options?: { file?: string; type?: string }
) {
  const matches: Array<SerializedSymbolNode & { callerCount: number; calleeCount: number }> = []
  const ids = graph.nameIndex.get(name) || []
  const scanIds = ids.length > 0 ? ids : [...graph.nodes.keys()].filter((id) => {
    const n = graph.nodes.get(id)!
    return n.name === name || n.qualifiedName === name || n.qualifiedName.endsWith(`.${name}`)
  })

  for (const id of scanIds) {
    const node = graph.nodes.get(id)
    if (!node) continue
    if (options?.file && !node.file.includes(options.file)) continue
    if (options?.type && node.type !== options.type) continue
    matches.push({
      ...node,
      callerCount: graph.callers.get(id)?.size ?? 0,
      calleeCount: graph.callees.get(id)?.size ?? 0,
    })
  }
  return matches
}

function neighborList(
  graph: SymbolGraphLoaded,
  ids: Set<string> | undefined,
  depth: number
): Array<{ id: string; name: string; file: string; line: number; type: SymbolType }> {
  if (!ids || depth < 1) return []
  const out: Array<{ id: string; name: string; file: string; line: number; type: SymbolType }> = []
  for (const id of ids) {
    const node = graph.nodes.get(id)
    if (node) {
      out.push({
        id: node.id,
        name: node.qualifiedName,
        file: node.file,
        line: node.line,
        type: node.type,
      })
    }
  }
  return out
}

export function getCallers(graph: SymbolGraphLoaded, symbolRef: string, depth = 1) {
  const id = resolveSymbolId(graph, symbolRef)
  if (!id) return []
  const seen = new Set<string>()
  let frontier = new Set(graph.callers.get(id) ?? [])
  const results = neighborList(graph, frontier, 1)
  seen.add(id)
  for (let d = 1; d < depth && frontier.size; d++) {
    const next = new Set<string>()
    for (const cid of frontier) {
      if (seen.has(cid)) continue
      seen.add(cid)
      for (const p of graph.callers.get(cid) ?? []) next.add(p)
    }
    results.push(...neighborList(graph, next, 1))
    frontier = next
  }
  return results
}

export function getCallees(graph: SymbolGraphLoaded, symbolRef: string, depth = 1) {
  const id = resolveSymbolId(graph, symbolRef)
  if (!id) return []
  const frontier = new Set(graph.callees.get(id) ?? [])
  return neighborList(graph, frontier, depth)
}

export function getRelatedSymbols(graph: SymbolGraphLoaded, symbolRef: string) {
  const id = resolveSymbolId(graph, symbolRef)
  if (!id) {
    return {
      symbol: null,
      callers: [] as ReturnType<typeof getCallers>,
      callees: [] as ReturnType<typeof getCallees>,
      coLocated: [] as Array<{ id: string; name: string; type: SymbolType; line: number }>,
      relatedTypes: [] as Array<{ id: string; name: string; file: string }>,
    }
  }
  const node = graph.nodes.get(id)!
  const symbol = {
    ...node,
    callerCount: graph.callers.get(id)?.size ?? 0,
    calleeCount: graph.callees.get(id)?.size ?? 0,
  }
  const callers = getCallers(graph, id, 1)
  const callees = getCallees(graph, id, 1)

  const coLocated: Array<{ id: string; name: string; type: SymbolType; line: number }> = []
  const relatedTypes: Array<{ id: string; name: string; file: string }> = []
  for (const symId of graph.fileIndex.get(node.file) || []) {
    if (symId === id) continue
    const sym = graph.nodes.get(symId)
    if (!sym) continue
    coLocated.push({ id: symId, name: sym.qualifiedName, type: sym.type, line: sym.line })
    if (sym.type === 'interface' || sym.type === 'type' || sym.type === 'enum') {
      relatedTypes.push({ id: symId, name: sym.qualifiedName, file: sym.file })
    }
  }

  return { symbol, callers, callees, coLocated, relatedTypes }
}

export function traceCallChain(
  graph: SymbolGraphLoaded,
  source: string,
  target: string,
  maxDepth = 5
): string[] | null {
  const sourceId = resolveSymbolId(graph, source)
  const targetId = resolveSymbolId(graph, target)
  if (!sourceId || !targetId) return null

  const queue: Array<{ id: string; path: string[] }> = [{ id: sourceId, path: [sourceId] }]
  const visited = new Set<string>([sourceId])

  while (queue.length) {
    const { id, path } = queue.shift()!
    if (path.length > maxDepth) continue
    if (id === targetId) return path.map((pid) => graph.nodes.get(pid)?.qualifiedName ?? pid)
    for (const next of graph.callees.get(id) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push({ id: next, path: [...path, next] })
    }
  }
  return null
}

export function analyzeImpact(graph: SymbolGraphLoaded, symbolRef: string) {
  const id = resolveSymbolId(graph, symbolRef)
  if (!id) {
    return { directCallers: [], indirectCallers: [], typeDependents: [], fileRipple: [], testFiles: [] }
  }
  const node = graph.nodes.get(id)!
  const directCallers = getCallers(graph, id, 1)
  const indirectCallers = getCallers(graph, id, 3).filter(
    (c) => !directCallers.some((d) => d.id === c.id)
  )
  const typeDependents = (graph.fileIndex.get(node.file) || [])
    .map((sid) => graph.nodes.get(sid))
    .filter((s) => s && (s.type === 'interface' || s.type === 'type'))
    .map((s) => ({ id: s!.id, name: s!.qualifiedName, file: s!.file }))

  const fileRipple = new Set<string>()
  for (const c of [...directCallers, ...indirectCallers]) fileRipple.add(c.file)

  const testFiles = [...fileRipple].filter(
    (f) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f) || /__tests__\//.test(f)
  )

  return {
    symbol: node,
    directCallers,
    indirectCallers,
    typeDependents,
    fileRipple: [...fileRipple],
    testFiles,
  }
}
