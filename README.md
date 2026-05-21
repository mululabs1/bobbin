# Bobbin

**Local code intelligence for Cursor and Claude Code.** Symbol graph, callers/callees, impact analysis, BM25 search — all local, no cloud, no telemetry.

Bobbin gives your AI agent a real index of your codebase. Instead of `grep`ing through thousands of files, the agent asks the symbol graph: *who calls this function? what does it depend on? what breaks if I change it?* — and gets a precise answer in milliseconds.

---

## Why

Out of the box, Cursor and Claude Code lean on `grep` and `glob`. That works for literal strings, but it falls over the moment you ask *who calls `authenticate`?* or *what happens if I rename `Order.total`?* The agent ends up reading dozens of files just to map the local neighborhood of a single symbol.

Bobbin pre-computes that map. The first time the agent encounters your codebase, it runs `index_codebase`. After that:

- **`find_symbol("authenticate")`** — one call, returns every definition with file/line/signature.
- **`get_callers("authenticate", depth=2)`** — one call, returns every caller up to two hops.
- **`analyze_impact("Order.total")`** — one call, returns direct callers, indirect callers, type dependents, file ripple, and inferred test files.

Same model. Same task. Roughly 10× fewer tool calls and dramatically less context burned reading unrelated code.

---

## Install

### Prerequisites

- **Node.js 20+**
- You must `npm install` inside the cloned repo before either editor will launch the MCP server. `npx tsx` can fetch its own loader on demand, but Bobbin's runtime deps (`@modelcontextprotocol/sdk`, `fast-glob`, `zod`) need to be on disk.

### Cursor

The bundled `mcp.json` assumes the plugin is cloned into Cursor's documented local-plugin location (`~/.cursor/plugins/local/bobbin`). If you clone somewhere else, edit the path in `mcp.json` to match.

```bash
git clone https://github.com/mululabs1/bobbin.git ~/.cursor/plugins/local/bobbin
cd ~/.cursor/plugins/local/bobbin
npm install
```

Then in Cursor: **Settings → Plugins**, enable **Bobbin**, restart Cursor (or `Developer: Reload Window`), open a project, and ask the agent to run **`index_codebase`**.

If Cursor doesn't see the plugin, you can wire the MCP server in directly. Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bobbin": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/bobbin/packages/index-mcp-server/src/index.ts"
      ]
    }
  }
}
```

### Claude Code

Clone Bobbin anywhere, install deps, and add the MCP server.

```bash
git clone https://github.com/mululabs1/bobbin.git
cd bobbin
npm install
claude mcp add bobbin -- npx tsx "$(pwd)/packages/index-mcp-server/src/index.ts"
```

Or, for the full plugin (with the bobbin-index skill, the graph-first rule, and hooks): install Bobbin as a plugin via Claude Code's plugin system. The bundled `.claude-plugin/plugin.json` and `.mcp.json` use `${CLAUDE_PLUGIN_ROOT}`, which Claude Code expands automatically when it loads a plugin folder.

Restart Claude Code, open a project, and ask the agent to run **`index_codebase`**.

### What gets created

Bobbin writes to a single directory per project: **`.bobbin/`**

```
.bobbin/
├── index/
│   ├── symbolGraph.json   # nodes, callers, callees, file/name indices
│   └── chunks.json        # source chunks for BM25 search
├── open-files.json        # optional: list of files you have open
└── .reindex-pending       # marker file written by the FileChanged hook
```

Add `.bobbin/` to `.gitignore` — it's a local cache, not source.

---

## MCP tools

| Tool | What it does |
|------|--------------|
| `index_codebase` | Build or refresh `.bobbin/index` |
| `index_status` | Check whether the index exists |
| `set_open_files` | Tell Bobbin which files you have open (boosts ranking) |
| `find_symbol` | Find a function/class/type by name |
| `get_related_symbols` | Full neighborhood: callers, callees, co-located, related types |
| `get_callers` | Functions that call this symbol (transitive, depth-bounded) |
| `get_callees` | Functions called by this symbol |
| `trace_call_chain` | BFS path from one symbol to another |
| `analyze_impact` | Blast radius before edits: direct + indirect callers, type dependents, file ripple, inferred tests |
| `get_symbol_card` | Compact summary if `symbolCards.json` is present (optional artifact) |
| `codebase_search` | Local BM25 over indexed chunks (no embeddings) |
| `grep` | Regex/text search across files |
| `glob` | File-pattern listing |

All tools are **local**. Bobbin never makes a network request.

---

## Hooks

Two optional editor hooks ship with the plugin:

- **`FileChanged`** — writes `.bobbin/.reindex-pending`. The MCP server picks the flag up on the next tool call and re-indexes incrementally.
- **`UserPromptSubmit`** — if `BOBBIN_OPEN_FILES` is set in your shell (`BOBBIN_OPEN_FILES="src/a.ts,src/b.ts"`), the hook writes those paths to `.bobbin/open-files.json` so the agent can pick up your current focus without being told.

The hooks are wired in `hooks/hooks.json`. If you'd rather wire them yourself, the scripts are at `packages/index-mcp-server/scripts/`.

---

## Language support (v0.1)

Bobbin's indexer extracts symbols via language-specific patterns. Out of the box:

| Language | Extracted |
|---|---|
| TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`) | functions, classes, methods, interfaces, types, enums |
| Python (`.py`) | functions, methods, classes |
| Go (`.go`) | functions, methods, structs, interfaces |
| Rust (`.rs`) | fn, struct, trait, enum, impl methods |
| Java (`.java`) | classes, interfaces, methods |
| Ruby (`.rb`) | classes, modules, methods |

Callers and callees are inferred by scanning each symbol's body for identifiers that match other known symbols in the graph. This is a v0.1 heuristic — accurate for unique names, conservative for common ones (e.g. `get`, `run`). Tree-sitter-based parsing is on the roadmap for v0.2.

---

## Configuration

Bobbin reads a small set of environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `BOBBIN_WORKSPACE_ROOT` | Project root the MCP server operates against | Editor-set `CURSOR_WORKSPACE` / `CLAUDE_WORKSPACE`, else `$PWD` |
| `BOBBIN_INDEX_DIR` | Where the index is written, relative to project root | `.bobbin/index` |
| `BOBBIN_OPEN_FILES` | Comma-separated list of files the user has open | unset |

You generally don't need to set any of these — the defaults work out of the box.

---

## What Bobbin is not

- **Not a vector database.** No embeddings, no Chroma, no Qdrant, no cloud. Bobbin uses BM25 over chunks and a symbol graph derived from regex parsing.
- **Not a hosted service.** Everything runs in your editor's MCP process.
- **Not a replacement for tree-sitter / LSP.** The v0.1 indexer is regex-based. It's accurate enough for most callers/callees questions but it isn't a real compiler frontend.

---

## Known issues (v0.1)

- Multi-line function signatures (a `function foo(` with `)` and `{` on later lines) get a slightly-too-narrow `endLine`. Symbols are still extracted correctly; only the recorded range is short. Fixed by the tree-sitter rewrite landing in v0.2.
- `npx tsx` requires `npm install` to have run first — `tsx` itself loads on demand, but Bobbin's own deps (`@modelcontextprotocol/sdk`, `fast-glob`, `zod`) need to be on disk.
- If Cursor doesn't pick up `.cursor-plugin/plugin.json` automatically, fall back to editing `~/.cursor/mcp.json` directly (snippet above).

---

## Contributing

Issues and PRs welcome. Particularly interested in:

- More language extractors (PHP, C#, Swift, Kotlin, Elixir, Haskell)
- Tree-sitter-based parsing as a drop-in for the regex extractors
- Symbol cards (compact one-paragraph summaries) generated locally
- Performance work on large monorepos

---

## License

MIT
