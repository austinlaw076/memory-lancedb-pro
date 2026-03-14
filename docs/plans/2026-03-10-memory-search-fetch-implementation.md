# Memory Search Fetch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add standardized retrieval-style `search` and `fetch` tools to `memory-lancedb-pro`.

**Architecture:** Extend the MCP runtime with exact-ID fetch helpers and normalized result mappers, then expose two new read-only tools from both stdio and HTTP servers. Reuse existing hybrid retrieval and Graphiti integrations instead of inventing a second search stack.

**Tech Stack:** Node.js, MCP JSON-RPC, existing memory runtime, Graphiti bridge/helpers.

---

### Task 1: Inspect runtime support for exact lookup

**Files:**
- Modify: `/home/austin/Development/research/memory-lancedb-pro/src/mcp/runtime.mjs`
- Reference: `/home/austin/Development/research/memory-lancedb-pro/src/store.js`
- Reference: `/home/austin/Development/research/memory-lancedb-pro/src/graphiti/`

**Step 1: Find existing exact-get APIs**

Run: `rg -n "getById|findById|entry.id|graph" /home/austin/Development/research/memory-lancedb-pro/src`
Expected: identify whether store and Graphiti helpers already expose exact lookup.

**Step 2: If exact lookup is missing, write the smallest helper needed**

Add runtime-local helper functions to resolve:
- memory entry by ID
- graph fact by ID
- graph node by ID

**Step 3: Keep helper boundaries narrow**

Do not redesign store interfaces unless exact lookup cannot be done any other way.

### Task 2: Add normalized result mappers

**Files:**
- Modify: `/home/austin/Development/research/memory-lancedb-pro/src/mcp/runtime.mjs`

**Step 1: Add ID parsing helpers**

Implement parser for:
- `memory:entry:<id>`
- `memory:fact:<id>`
- `memory:node:<id>`

**Step 2: Add formatters**

Implement:
- `formatSearchResult(...)`
- `formatFetchResult(...)`

Each formatter must emit the standardized fields:
- `id`
- `title`
- `text` or `content`
- `url`
- `type`
- `source`
- `metadata`

**Step 3: Keep text short in search**

Search result text should be a concise excerpt, not full payload.

### Task 3: Implement runtime `toolSearch`

**Files:**
- Modify: `/home/austin/Development/research/memory-lancedb-pro/src/mcp/runtime.mjs`

**Step 1: Validate input**

Accept:
- `query`
- `type`
- `limit`
- `scope`

Reject unsupported `type` values with structured error output.

**Step 2: Reuse current retrieval**

- use hybrid retriever for memory entries
- use graph recall path for graph facts/nodes when enabled

**Step 3: Normalize output**

Return structured content like:

```json
{
  "results": [],
  "nextCursor": null
}
```

### Task 4: Implement runtime `toolFetch`

**Files:**
- Modify: `/home/austin/Development/research/memory-lancedb-pro/src/mcp/runtime.mjs`

**Step 1: Parse exact ID**

Dispatch by ID prefix rather than fuzzy search.

**Step 2: Fetch exact backend record**

- memory entry -> store lookup
- graph fact/node -> Graphiti lookup

**Step 3: Return normalized full record**

Use `content` instead of `text` for the full body.

### Task 5: Expose MCP tool definitions

**Files:**
- Modify: `/home/austin/Development/research/memory-lancedb-pro/src/mcp/server.mjs`
- Modify: `/home/austin/Development/research/memory-lancedb-pro/src/mcp/server-http.mjs`

**Step 1: Add `search` and `fetch` to tool list**

Schemas:
- `search`: `query`, optional `type`, `limit`, `scope`
- `fetch`: `id`

**Step 2: Mark annotations explicitly**

Set:
- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

**Step 3: Wire tool handlers**

- `search` -> `runtime.toolSearch(...)`
- `fetch` -> `runtime.toolFetch(...)`

### Task 6: Verify locally

**Files:**
- Test via commands only

**Step 1: Syntax check**

Run: `node --check /home/austin/Development/research/memory-lancedb-pro/src/mcp/server.mjs`
Run: `node --check /home/austin/Development/research/memory-lancedb-pro/src/mcp/server-http.mjs`

**Step 2: Restart service**

Run: `systemctl --user restart memory-lancedb-pro-mcp.service`

**Step 3: Verify stdio**

Run initialize and `tools/list`, then confirm `search` and `fetch` appear with read-only annotations.

**Step 4: Verify HTTP**

Run authenticated or local HTTP MCP calls:
- `initialize`
- `tools/list`
- `search`
- `fetch` from returned ID

### Task 7: Record follow-up constraints

**Files:**
- Modify: `/home/austin/Development/research/memory-lancedb-pro/docs/plans/2026-03-10-memory-search-fetch-design.md`

**Step 1: Update design doc if implementation uncovers Graphiti lookup limits**

If exact fact/node lookup is not practical in v1, document narrowed scope rather than silently diverging.
