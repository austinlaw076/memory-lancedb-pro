# Memory-Lancedb-Pro MCP Schema Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the Graphiti recall contract across MCP and reflection callers so routing-mode recall works without stale `groupId` assumptions.

**Architecture:** Keep the new multi-group read model (`groupIds`) as the source of truth and update stale callers to format/output that shape consistently. Add regression tests at the caller layer so future schema changes break fast in tests instead of at MCP runtime.

**Tech Stack:** TypeScript, Node.js, jiti-based tests, MCP JSON-RPC runtime.

---

### Task 1: Lock the new recall contract with tests

**Files:**
- Modify: `test/unit-graphiti-reflection.test.mjs`
- Modify: `test/graphiti-smoke.mjs`

**Step 1: Write/update failing tests**

Update the reflection and smoke test mocks to return `groupIds` instead of `groupId`, and assert the rendered output/structured details use the new shape.

**Step 2: Run tests to verify failure**

Run: `node test/unit-graphiti-reflection.test.mjs && node test/graphiti-smoke.mjs`

Expected: failure in reflection and/or MCP recall formatting due to stale `groupId` references.

### Task 2: Patch stale callers

**Files:**
- Modify: `src/graphiti/reflection.ts`
- Modify: `src/mcp/runtime.ts`

**Step 1: Update reflection contract**

Replace `groupId` usage with `groupIds`, keeping a readable single-string summary where needed by joining the IDs.

**Step 2: Update MCP runtime contract**

Align `toolGraphRecall()` in `src/mcp/runtime.ts` with `runtime.mjs` so text and structured output expose `groupIds`.

**Step 3: Keep the change minimal**

Do not refactor unrelated graphiti code; only patch stale call sites and result types.

### Task 3: Verify end-to-end behavior

**Files:**
- Verify: `test/unit-graphiti-reflection.test.mjs`
- Verify: `test/unit-graphiti-mcp.test.mjs`
- Verify: `test/graphiti-smoke.mjs`

**Step 1: Run targeted verification**

Run: `node test/unit-graphiti-reflection.test.mjs && node test/unit-graphiti-mcp.test.mjs && node test/graphiti-smoke.mjs`

Expected: all pass.

**Step 2: Run broader suite**

Run: `npm test`

Expected: exit code 0 with graphiti smoke still passing.
