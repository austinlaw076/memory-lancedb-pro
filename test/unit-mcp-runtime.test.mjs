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
