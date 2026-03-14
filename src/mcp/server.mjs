#!/usr/bin/env node
/**
 * MCP Server for memory-lancedb-pro
 * 
 * This server exposes memory tools via the Model Context Protocol (MCP)
 * over stdio, allowing Codex, Claude Code, and other agents to access
 * the shared memory engine.
 * 
 * Usage:
 *   node src/mcp/server.mjs
 * 
 * Environment Variables (optional):
 *   MEMORY_LANCEDB_PRO_MCP_OPENCLAW_CONFIG - Path to openclaw.json (default: ~/.openclaw/openclaw.json)
 *   MEMORY_LANCEDB_PRO_MCP_PLUGIN_ENTRY - Plugin entry name (default: memory-lancedb-pro)
 *   MEMORY_LANCEDB_PRO_MCP_DEFAULT_SCOPE - Default scope (default: global)
 *   MEMORY_LANCEDB_PRO_MCP_ACCESS_MODE - "all" or "scoped" (default: all)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import jiti from "jiti";

const importRuntime = () => jiti(import.meta.url)("./runtime.mjs");

let runtime = null;
let requestId = 1;
let outputMode = "content-length";
const FORCE_NON_DESTRUCTIVE_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
};
const READ_ONLY_TOOLS = new Set(["search", "fetch", "memory_recall", "memory_graph_recall"]);
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

preloadOpenClawSecrets();

const TOOLS = [
  {
    name: "search",
    description: "Search standardized retrieval results from memory entries and graph recall output.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        type: {
          type: "string",
          description: "Optional result type filter",
          enum: ["memory_entry", "graph_fact", "graph_node"],
        },
        limit: { type: "number", description: "Max results to return (default: 5)", default: 5 },
        scope: { type: "string", description: "Scope filter (optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: "Fetch a single standardized retrieval result by exact id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact retrieval result id, for example memory:entry:<id>" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_store",
    description: "Store a new memory in the shared memory system.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Memory text content" },
        importance: { type: "number", description: "Importance score 0-1 (default: 0.7)" },
        category: { 
          type: "string", 
          description: "Category: fact, decision, preference, entity, reflection, other",
          enum: ["fact", "decision", "preference", "entity", "reflection", "other"]
        },
        scope: { type: "string", description: "Memory scope (default: global)" },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_recall",
    description: "Search and retrieve memories using hybrid retrieval (Vector + BM25).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        limit: { type: "number", description: "Max results to return (default: 5)", default: 5 },
        scope: { type: "string", description: "Scope filter (optional)" },
        category: { type: "string", description: "Category filter (optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory in-place.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "Memory ID to update" },
        text: { type: "string", description: "New text content (triggers re-embedding)" },
        importance: { type: "number", description: "New importance score 0-1" },
        category: { type: "string", description: "New category" },
      },
      required: ["memoryId"],
    },
  },
  {
    name: "memory_forget",
    description: "Delete specific memories by ID or search query.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "Specific memory ID to delete" },
        query: { type: "string", description: "Search query to find memories to delete" },
        scope: { type: "string", description: "Scope to search/delete from" },
      },
    },
  },
  {
    name: "memory_graph_recall",
    description: "Query graph-based facts/entities from Graphiti knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        scope: { type: "string", description: "Scope (default: global)" },
        limitNodes: { type: "number", description: "Max nodes to return (default: 6)", default: 6 },
        limitFacts: { type: "number", description: "Max facts to return (default: 10)", default: 10 },
      },
      required: ["query"],
    },
  },
];

async function initialize() {
  if (runtime) return;
  
  const { createMemoryMcpRuntime } = await importRuntime();
  runtime = await createMemoryMcpRuntime({
    defaultScope: "global",
    accessMode: "all",
  });
  
  runtime.logger.info("mcp_server_started", {
    version: "1.0.0-phase1",
    tools: TOOLS.map(t => t.name),
  });
}

function sendResponse(response) {
  const payload = JSON.stringify(response);
  if (outputMode === "ndjson") {
    process.stdout.write(`${payload}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

function negotiateProtocolVersion(requestedVersion) {
  if (typeof requestedVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
    return requestedVersion;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

function preloadOpenClawSecrets() {
  const configPath = expandHome(
    process.env.MEMORY_LANCEDB_PRO_MCP_OPENCLAW_CONFIG || "~/.openclaw/openclaw.json",
  );
  const secretsPath = resolve(dirname(configPath), "secrets.env");

  try {
    const content = readFileSync(secretsPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const key = line.slice(0, eqIndex).trim();
      if (!key || process.env[key]) {
        continue;
      }
      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Optional env source; ignore when not present.
  }
}

function expandHome(value) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

async function handleRequest(request) {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize": {
        await initialize();
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: "memory-lancedb-pro",
              version: "1.0.0-phase1",
            },
          },
        };
        sendResponse(response);
        break;
      }

      case "notifications/initialized": {
        break;
      }

      case "tools/list": {
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS.map((tool) => ({
              ...tool,
              annotations: {
                readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
                ...tool.annotations,
                ...FORCE_NON_DESTRUCTIVE_ANNOTATIONS,
              },
            })),
          },
        };
        sendResponse(response);
        break;
      }

      case "tools/call": {
        if (!runtime) {
          await initialize();
        }

        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        let result;

        switch (toolName) {
          case "search":
            result = await runtime.toolSearch(toolArgs);
            break;
          case "fetch":
            result = await runtime.toolFetch(toolArgs);
            break;
          case "memory_store":
            result = await runtime.toolStore(toolArgs);
            break;
          case "memory_recall":
            result = await runtime.toolRecall(toolArgs);
            break;
          case "memory_update":
            result = await runtime.toolUpdate(toolArgs);
            break;
          case "memory_forget":
            result = await runtime.toolForget(toolArgs);
            break;
          case "memory_graph_recall":
            result = await runtime.toolGraphRecall(toolArgs);
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }

        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: result.content,
                ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
              },
            ],
            isError: result.isError,
          },
        };
        sendResponse(response);
        break;
      }

      case "resources/list": {
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              {
                uri: "memory://logger/path",
                name: "Log File Path",
                description: "Path to the MCP server log file",
                mimeType: "text/plain",
              },
            ],
          },
        };
        sendResponse(response);
        break;
      }

      case "resources/read": {
        const uri = params?.uri;
        let content = "";
        
        if (uri === "memory://logger/path") {
          content = runtime?.logger.getPath() || "Logger not initialized";
        }

        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/plain",
                text: content,
              },
            ],
          },
        };
        sendResponse(response);
        break;
      }

      default: {
        if (id === undefined || id === null) {
          break;
        }
        const response = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
        sendResponse(response);
      }
    }
  } catch (error) {
    const response = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
        data: error,
      },
    };
    sendResponse(response);
  }
}

async function main() {
  let buffer = "";

  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (chunk) => {
    buffer += chunk;

    while (true) {
      let body;

      if (buffer.startsWith("Content-Length:")) {
        outputMode = "content-length";
        const headerMatch = buffer.match(/Content-Length:\s*(\d+)\r\n/);
        if (!headerMatch) {
          return;
        }

        const contentLength = parseInt(headerMatch[1], 10);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) {
          return;
        }

        body = buffer.slice(bodyStart, bodyEnd);
        buffer = buffer.slice(bodyEnd);
      } else {
        outputMode = "ndjson";
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        body = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!body) {
          continue;
        }
      }

      try {
        const request = JSON.parse(body);
        await handleRequest(request);
      } catch (error) {
        console.error("Failed to parse request:", error);
      }
    }
  });

  process.stdin.on("end", () => {
    runtime?.logger.info("mcp_server_stdin_closed", {});
    process.exit(0);
  });

  process.on("SIGINT", () => {
    runtime?.logger.info("mcp_server_sigint", {});
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    runtime?.logger.info("mcp_server_sigterm", {});
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Server crashed:", error);
  process.exit(1);
});
