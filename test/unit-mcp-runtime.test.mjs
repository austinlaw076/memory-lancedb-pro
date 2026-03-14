import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});
const { createMemoryMcpRuntime } = jiti("../src/mcp/runtime.ts");

function writeOpenClawConfig(rootDir, pluginConfig) {
  const configPath = path.join(rootDir, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "memory-lancedb-pro": {
              enabled: true,
              config: pluginConfig,
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}

test("memory MCP runtime initializes from temp config and fails closed on disabled graph recall", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-mcp-runtime-"));

  try {
    const dbPath = path.join(rootDir, "db");
    const configPath = writeOpenClawConfig(rootDir, {
      embedding: {
        apiKey: "test-api-key",
      },
      dbPath,
      accessTracking: {
        enabled: false,
      },
      graphiti: {
        enabled: false,
      },
    });

    const runtime = await createMemoryMcpRuntime({
      openclawConfigPath: configPath,
      defaultScope: "global",
      accessMode: "all",
    });

    assert.equal(runtime.defaultScope, "global");
    assert.equal(runtime.accessMode, "all");
    assert.equal(runtime.graphitiBridge, undefined);

    const graphRecall = await runtime.toolGraphRecall({ query: "alice preference" });
    assert.equal(graphRecall.isError, true);
    assert.deepEqual(graphRecall.structuredContent, { error: "graphiti_disabled" });

    const missingStore = await runtime.toolStore({});
    assert.equal(missingStore.isError, true);
    assert.deepEqual(missingStore.structuredContent, { error: "missing_text" });

    const missingRecall = await runtime.toolRecall({});
    assert.equal(missingRecall.isError, true);
    assert.deepEqual(missingRecall.structuredContent, { error: "missing_query" });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("memory MCP runtime search/fetch returns normalized memory results", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-mcp-search-fetch-"));

  try {
    const dbPath = path.join(rootDir, "db");
    const configPath = writeOpenClawConfig(rootDir, {
      embedding: {
        apiKey: "test-api-key",
      },
      dbPath,
      accessTracking: {
        enabled: false,
      },
      graphiti: {
        enabled: false,
      },
    });

    const runtime = await createMemoryMcpRuntime({
      openclawConfigPath: configPath,
      defaultScope: "global",
      accessMode: "all",
    });

    const dims = runtime.embedder.dimensions;
    runtime.embedder.embedPassage = async () => new Array(dims).fill(0.1);
    runtime.embedder.embedQuery = async () => new Array(dims).fill(0.1);

    const stored = await runtime.toolStore({
      text: "User preference: prefers Traditional Chinese output.",
      category: "preference",
      scope: "global",
    });
    assert.equal(stored.isError, undefined);
    const memoryId = stored.structuredContent.memory.id;

    const search = await runtime.toolSearch({ query: "Traditional Chinese", limit: 3 });
    assert.equal(search.isError, undefined);
    assert.equal(search.structuredContent.results.length, 1);
    assert.deepEqual(search.structuredContent.results[0], {
      id: `memory:entry:${memoryId}`,
      title: "preference / global",
      text: "User preference: prefers Traditional Chinese output.",
      url: null,
      type: "memory_entry",
      source: "memory",
      metadata: {
        category: "preference",
        scope: "global",
        importance: 0.7,
        timestamp: search.structuredContent.results[0].metadata.timestamp,
      },
    });

    const fetched = await runtime.toolFetch({ id: `memory:entry:${memoryId}` });
    assert.equal(fetched.isError, undefined);
    assert.deepEqual(fetched.structuredContent.result, {
      id: `memory:entry:${memoryId}`,
      title: "preference / global",
      content: "User preference: prefers Traditional Chinese output.",
      url: null,
      type: "memory_entry",
      source: "memory",
      metadata: {
        category: "preference",
        scope: "global",
        importance: 0.7,
        timestamp: fetched.structuredContent.result.metadata.timestamp,
        metadata: {},
      },
    });

    const invalid = await runtime.toolFetch({ id: "bad-id" });
    assert.equal(invalid.isError, true);
    assert.deepEqual(invalid.structuredContent, { error: "invalid_id", id: "bad-id" });

    const unsupportedGraph = await runtime.toolFetch({ id: "memory:fact:abc" });
    assert.equal(unsupportedGraph.isError, true);
    assert.deepEqual(unsupportedGraph.structuredContent, {
      error: "unsupported_source",
      id: "memory:fact:abc",
      kind: "fact",
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
