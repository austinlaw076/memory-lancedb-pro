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

import jiti from "jiti";

const importRuntime = () => jiti(import.meta.url)("./runtime.mjs");

let runtime = null;
let requestId = 1;

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
  
  runtime.logger.info("mcp_server_started", {
    version: "1.0.0-phase1",
    tools: TOOLS.map(t => t.name),
  });
}

function sendResponse(response) {
  process.stdout.write(`Content-Length: ${JSON.stringify(response).length}\r\n\r\n${JSON.stringify(response)}`);
}

function sendNotification(method, params) {
  const response = {
    jsonrpc: "2.0",
    method,
    result: params,
  };
  process.stdout.write(`Content-Length: ${JSON.stringify(response).length}\r\n\r\n${JSON.stringify(response)}`);
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
            protocolVersion: "2024-11-05",
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
        sendNotification("notifications/initialized", {});
        break;
      }

      case "tools/list": {
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS,
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

    // Parse Content-Length headers
    const headerMatch = buffer.match(/Content-Length:\s*(\d+)\r\n/);
    if (!headerMatch) return;

    const contentLength = parseInt(headerMatch[1], 10);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    
    if (headerEnd === -1) return;
    
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    
    if (buffer.length < bodyEnd) return;

    const body = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);

    try {
      const request = JSON.parse(body);
      await handleRequest(request);
    } catch (error) {
      console.error("Failed to parse request:", error);
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
