#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { searchChunksLocal } from './bm25-store.js'
import {
  analyzeImpact,
  findSymbol,
  getCallers,
  getCallees,
  getRelatedSymbols,
  loadSymbolGraph,
  traceCallChain,
} from './graph-store.js'
import { globSearch, grepSearch } from './grep.js'
import { getIndexDir, getWorkspaceRoot, isPathInsideRoot } from './paths.js'
import { indexProject } from './indexer.js'
import { checkReindexFlag } from './reindex-watcher.js'

const openFilesByProject = new Map<string, string[]>()

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  }
}

function errResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

const server = new Server(
  { name: 'bobbin', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

const TOOLS = [
  {
    name: 'index_codebase',
    description:
      'Build or refresh the local .bobbin/index (symbol graph, BM25 chunks). Run when the index is missing or stale. Fully local — no cloud API.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force full re-index' },
      },
    },
  },
  {
    name: 'index_status',
    description: 'Check whether .bobbin/index exists and the symbol graph is available.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_open_files',
    description:
      'Set editor open file paths so future ranking can favor relevant code. Stored in memory and at .bobbin/open-files.json.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Relative or absolute file paths' },
      },
      required: ['files'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Find functions/classes by name in the symbol graph. FREE — use before grep or codebase_search when you know a symbol name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        file: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_related_symbols',
    description:
      'Full symbol neighborhood: callers, callees, co-located symbols, related types. FREE — prefer over codebase_search.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'get_callers',
    description: 'Functions that call the given symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_callees',
    description: 'Functions called by the given symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'trace_call_chain',
    description: 'Find call path between two symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        target: { type: 'string' },
        maxDepth: { type: 'number' },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'analyze_impact',
    description: 'Blast radius before editing: callers, file ripple, inferred tests.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'get_symbol_card',
    description: 'Compact symbol summary if symbolCards.json is present (optional artifact).',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'codebase_search',
    description:
      'Search code by keywords (local BM25 over indexed chunks). No cloud embeddings. Index first with index_codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grep',
    description: 'Regex/text search. Last resort when you need literal strings.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        caseInsensitive: { type: 'boolean' },
        maxResults: { type: 'number' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
] as const

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}))

async function ensureGraph(projectPath: string) {
  const graph = await loadSymbolGraph(projectPath)
  if (!graph) {
    throw new Error(
      'Symbol graph not found. Call index_codebase first to build .bobbin/index/symbolGraph.json'
    )
  }
  return graph
}

async function syncOpenFilesFromDisk(projectPath: string) {
  try {
    const raw = await readFile(join(projectPath, '.bobbin', 'open-files.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { files?: string[] }
    if (parsed.files?.length) openFilesByProject.set(projectPath, parsed.files)
  } catch {
    /* optional */
  }
}

async function maybeReindex(projectPath: string) {
  await syncOpenFilesFromDisk(projectPath)
  const pending = await checkReindexFlag()
  if (!pending) return
  await indexProject(projectPath, false)
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const projectPath = getWorkspaceRoot()

  try {
    await maybeReindex(projectPath)

    switch (name) {
      case 'index_codebase': {
        const force = Boolean((args as { force?: boolean })?.force)
        const stats = await indexProject(projectPath, force)
        return textResult({ success: true, stats })
      }

      case 'index_status': {
        const graphPath = join(getIndexDir(projectPath), 'symbolGraph.json')
        let hasGraph = false
        let symbolCount: number | undefined
        try {
          const raw = await readFile(graphPath, 'utf-8')
          hasGraph = true
          const parsed = JSON.parse(raw) as { nodes?: unknown[] }
          symbolCount = parsed.nodes?.length
        } catch {
          /* empty */
        }
        return textResult({
          hasGraph,
          indexDir: getIndexDir(projectPath),
          symbolCount,
        })
      }

      case 'set_open_files': {
        const files = z.array(z.string()).parse((args as { files?: string[] })?.files)
        const normalized = files
          .map((f) => (isPathInsideRoot(f, projectPath) ? f : join(projectPath, f)))
          .filter((f) => isPathInsideRoot(f, projectPath))
        openFilesByProject.set(projectPath, normalized)
        return textResult({ ok: true, files: normalized })
      }

      case 'find_symbol': {
        const a = args as { name: string; file?: string; type?: string }
        const graph = await ensureGraph(projectPath)
        return textResult(findSymbol(graph, a.name, { file: a.file, type: a.type }))
      }

      case 'get_related_symbols': {
        const symbol = String((args as { symbol: string }).symbol)
        const graph = await ensureGraph(projectPath)
        return textResult(getRelatedSymbols(graph, symbol))
      }

      case 'get_callers': {
        const a = args as { symbol: string; depth?: number }
        const graph = await ensureGraph(projectPath)
        return textResult(getCallers(graph, a.symbol, Math.min(a.depth ?? 1, 3)))
      }

      case 'get_callees': {
        const a = args as { symbol: string; depth?: number }
        const graph = await ensureGraph(projectPath)
        return textResult(getCallees(graph, a.symbol, Math.min(a.depth ?? 1, 3)))
      }

      case 'trace_call_chain': {
        const a = args as { source: string; target: string; maxDepth?: number }
        const graph = await ensureGraph(projectPath)
        return textResult(traceCallChain(graph, a.source, a.target, a.maxDepth ?? 5))
      }

      case 'analyze_impact': {
        const symbol = String((args as { symbol: string }).symbol)
        const graph = await ensureGraph(projectPath)
        return textResult(analyzeImpact(graph, symbol))
      }

      case 'get_symbol_card': {
        const symbol = String((args as { symbol: string }).symbol)
        const cardsPath = join(getIndexDir(projectPath), 'symbolCards.json')
        try {
          const raw = await readFile(cardsPath, 'utf-8')
          const cards = JSON.parse(raw) as Record<string, unknown>
          const key = Object.keys(cards).find(
            (k) => k === symbol || k.endsWith(`:${symbol}`) || k.includes(symbol)
          )
          return textResult(key ? cards[key] : { error: 'Symbol card not found' })
        } catch {
          return errResult('symbolCards.json not found — this is an optional artifact')
        }
      }

      case 'codebase_search': {
        const a = args as { query: string; topK?: number }
        const topK = a.topK ?? 10
        const local = await searchChunksLocal(projectPath, a.query, topK)
        return textResult(local)
      }

      case 'grep': {
        const a = args as {
          pattern: string
          path?: string
          glob?: string
          outputMode?: 'content' | 'files_with_matches' | 'count'
          caseInsensitive?: boolean
          maxResults?: number
        }
        return textResult(await grepSearch(projectPath, a))
      }

      case 'glob': {
        const a = args as { pattern: string; path?: string }
        return textResult(await globSearch(projectPath, a.pattern, a.path))
      }

      default:
        return errResult(`Unknown tool: ${name}`)
    }
  } catch (e) {
    return errResult(e instanceof Error ? e.message : String(e))
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[bobbin] ready')
}

main().catch((e) => {
  console.error('[bobbin] fatal', e)
  process.exit(1)
})
