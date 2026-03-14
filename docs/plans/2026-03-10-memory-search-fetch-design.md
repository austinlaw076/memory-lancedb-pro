# Memory Search Fetch Design

**Goal:** Add retrieval-style `search` and `fetch` tools to `memory-lancedb-pro` so ChatGPT-style connectors can treat memory as a searchable knowledge source with stable IDs and predictable fetch semantics.

## Summary

`memory-lancedb-pro` already has strong internal retrieval via `memory_recall` and graph recall via `memory_graph_recall`, but those tools are optimized for direct agent use rather than standardized retrieval flows. The new design adds a thin compatibility layer with normalized result objects and deterministic IDs.

The first version supports three content types:
- `memory_entry`
- `graph_fact`
- `graph_node`

## Tool Contract

### `search`

**Input**
- `query: string`
- `type?: string`
- `limit?: number`
- `scope?: string`

**Output**
- `results: []`
- `nextCursor?: string` omitted in v1

Each result uses this shape:

```json
{
  "id": "memory:entry:882196da-9767-4624-81ce-123526724531",
  "title": "preference / global",
  "text": "User preference: after meaningful work...",
  "url": null,
  "type": "memory_entry",
  "source": "memory",
  "metadata": {
    "category": "preference",
    "scope": "global",
    "importance": 0.7,
    "timestamp": 1773130000000
  }
}
```

### `fetch`

**Input**
- `id: string`

**Output**

```json
{
  "id": "memory:entry:882196da-9767-4624-81ce-123526724531",
  "title": "preference / global",
  "content": "Full memory text...",
  "url": null,
  "type": "memory_entry",
  "source": "memory",
  "metadata": {}
}
```

## ID Scheme

- Memory entry: `memory:entry:<memoryId>`
- Graph fact: `memory:fact:<factId>`
- Graph node: `memory:node:<nodeId>`

The ID format must be reversible so `fetch` can recover the correct backend path without fuzzy matching.

## Backend Mapping

### Search

- `type` omitted:
  - run memory entry search through existing hybrid retrieval
  - if Graphiti is enabled, also run graph recall and map facts/nodes into normalized results
- `type=memory_entry`:
  - only run memory retrieval
- `type=graph_fact` or `type=graph_node`:
  - only run graph retrieval

### Fetch

- `memory:entry:*`
  - fetch by exact memory ID from the underlying store
- `memory:fact:*`
  - v1 returns `unsupported_source` because the current Graphiti bridge exposes recall/list flows but not a stable exact-get API
- `memory:node:*`
  - v1 returns `unsupported_source` for the same reason

## Result Formatting

- `title`
  - memory entries: `<category> / <scope>`
  - graph facts: short fact label or relation summary
  - graph nodes: entity label or canonical node name
- `text`
  - short searchable excerpt only, not full content dump
- `content`
  - full content only in `fetch`
- `url`
  - always `null` in v1

## Error Handling

- malformed `id` -> `invalid_id`
- unsupported graph fetch when Graphiti disabled -> `unsupported_source`
- missing item -> `not_found`
- backend failure -> `fetch_failed` or `search_failed`

## Annotations

Both tools should expose:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "openWorldHint": false
}
```

## V1 Limits

- no cursor pagination
- no cross-scope ranking optimization beyond current retriever behavior
- no exact graph fact/node fetch in v1; graph retrieval is search-only until Graphiti exposes a stable exact lookup path
- no public URL generation

## Verification

- local stdio `initialize` and `tools/list`
- local HTTP `initialize` and `tools/list`
- `search` for a known preference or decision memory
- `fetch` using an ID returned by `search`
- graph search/fetch only when Graphiti is enabled
