---
name: bobbin-index
description: Use Bobbin local codebase index — symbol graph, BM25 search, and graph-first navigation. Use when exploring code, finding callers/callees, or before edits.
---

# Bobbin local index

## When to use

- User asks how code connects, what calls a function, or what breaks if they change X
- You know a symbol name and need context
- Keyword/concept search over the repo (local BM25)
- Before editing existing functions or APIs

## Workflow

1. **`index_status`** — if no graph, run **`index_codebase`**
2. **`find_symbol`** or **`get_related_symbols`** for named symbols
3. **`analyze_impact`** before edits
4. **`codebase_search`** only when no symbol names are known
5. **`set_open_files`** when you know which files the user has open

## Tools (bobbin MCP)

| Tool | Use |
|------|-----|
| `index_codebase` | Build `.bobbin/index` |
| `find_symbol` | Resolve a name |
| `get_related_symbols` | Full neighborhood |
| `get_callers` / `get_callees` | Directed graph |
| `trace_call_chain` | Path between two symbols |
| `analyze_impact` | Blast radius |
| `get_symbol_card` | Compact summary (if available) |
| `codebase_search` | Local keyword/BM25 search |
| `grep` / `glob` | Literal / file patterns |

All indexing is **local**. No cloud API, no telemetry.
