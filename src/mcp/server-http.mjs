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
import jiti from "jiti";

const importRuntime = () => jiti(import.meta.url)("./runtime.mjs");

let runtime = null;

const TOOLS = [
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
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "memory-lancedb-pro", version: "1.0.0-phase1" },
        };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        // Send notification (no id)
        // Note: HTTP doesn't support notifications the same way, ignore
        return;
      }

      case "tools/list": {
        result = { tools: TOOLS };
        sendJsonRpcResponse(res, { jsonrpc: "2.0", id, result });
        return;
      }

      case "tools/call": {
        if (!runtime) await initialize();

        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        switch (toolName) {
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
