#!/usr/bin/env node
/**
 * MCP Server for memory-lancedb-pro (HTTP Mode)
 * 
 * This server exposes memory tools via MCP over HTTP.
 * Use this for ChatGPT / GPT connectors that need HTTP transport.
 * 
 * Usage:
 *   node src/mcp/server-http.mjs
 * 
 * Environment Variables:
 *   MEMORY_LANCEDB_PRO_MCP_PORT - HTTP port (default: 3099)
 *   MEMORY_LANCEDB_PRO_MCP_HOST - HTTP host (default: 127.0.0.1)
 *   MEMORY_LANCEDB_PRO_MCP_OPENCLAW_CONFIG - Path to openclaw.json
 *   MEMORY_LANCEDB_PRO_MCP_PLUGIN_ENTRY - Plugin entry name
 *   MEMORY_LANCEDB_PRO_MCP_DEFAULT_SCOPE - Default scope
 *   MEMORY_LANCEDB_PRO_MCP_ACCESS_MODE - "all" or "scoped"
 * 
 * Endpoint:
 *   POST /mcp - JSON-RPC 2.0 MCP calls
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import jiti from "jiti";

const importRuntime = () => jiti(import.meta.url)("./runtime.mjs");

let runtime = null;
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
  
  runtime.logger.info("mcp_http_server_started", {
    version: "1.0.0-phase1",
    tools: TOOLS.map(t => t.name),
  });
}

function sendJsonRpcResponse(res, response) {
  const body = JSON.stringify(response);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonRpcError(res, code, message, id = null) {
  const response = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  sendJsonRpcResponse(res, response);
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

async function handleJsonRpc(res, body) {
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    sendJsonRpcError(res, -32700, "Parse error");
    return;
  }

  const { method, params, id } = request;

  if (request.jsonrpc !== "2.0") {
    sendJsonRpcError(res, -32600, "Invalid Request: jsonrpc must be 2.0", id);
    return;
  }

  try {
    let result;

    switch (method) {
      case "initialize": {
        await initialize();
        result = {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "memory-lancedb-pro", version: "1.0.0-phase1" },
        };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        // Send notification (no id)
        // Note: HTTP doesn't support notifications the same way, ignore
        return;
      }

      case "notifications/initialized": {
        res.writeHead(202).end();
        return;
      }

      case "tools/list": {
        result = {
          tools: TOOLS.map((tool) => ({
            ...tool,
            annotations: {
              readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
              ...tool.annotations,
              ...FORCE_NON_DESTRUCTIVE_ANNOTATIONS,
            },
          })),
        };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        return;
      }

      case "tools/call": {
        if (!runtime) await initialize();

        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

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
        if (id === undefined || id === null) {
          res.writeHead(202).end();
          return;
        }
        throw new Error(`Unknown tool: ${toolName}`);
        }

        result = {
          content: [
            {
              type: "text",
              text: result.content,
              ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
            },
          ],
          isError: result.isError,
        };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        return;
      }

      case "resources/list": {
        result = {
          resources: [
            { uri: "memory://logger/path", name: "Log File Path", description: "Path to log file", mimeType: "text/plain" },
          ],
        };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        return;
      }

      case "resources/read": {
        const uri = params?.uri;
        let content = "";
        if (uri === "memory://logger/path") {
          content = runtime?.logger.getPath() || "Logger not initialized";
        }
        result = { contents: [{ uri, mimeType: "text/plain", text: content }] };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        return;
      }

      default:
        sendJsonRpcError(res, -32601, `Method not found: ${method}`, id);
        return;
    }
  } catch (error) {
    sendJsonRpcError(res, -32603, error instanceof Error ? error.message : String(error), id);
  }
}

const PORT = parseInt(process.env.MEMORY_LANCEDB_PRO_MCP_PORT || "3099", 10);
const HOST = process.env.MEMORY_LANCEDB_PRO_MCP_HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  // CORS headers for flexibility
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/mcp") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    await handleJsonRpc(res, body);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "memory-lancedb-pro-mcp" }));
    return;
  }

  // MCP SSE endpoint (optional for streaming)
  if (req.method === "GET" && req.url === "/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("event: connected\ndata: ok\n\n");
    // Keep connection open for server-sent events if needed
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`memory-lancedb-pro MCP HTTP server running at http://${HOST}:${PORT}/mcp`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
});

server.on("error", (err) => {
  console.error("Server error:", err);
  process.exit(1);
});
