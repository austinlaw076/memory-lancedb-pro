import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { GraphitiMcpClient } = jiti("../src/graphiti/mcp.ts");

function normalizeHeaders(input) {
  const output = {};
  if (!input) return output;

  if (typeof input.entries === "function") {
    for (const [key, value] of input.entries()) {
      output[String(key).toLowerCase()] = String(value);
    }
    return output;
  }

  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      output[String(key).toLowerCase()] = String(value);
    }
    return output;
  }

  if (typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      output[String(key).toLowerCase()] = String(value);
    }
  }
  return output;
}

test("graphiti MCP client initializes session and applies auth/session headers", async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = process.env.GRAPHITI_TOKEN_TEST;
  const seenMethods = [];

  process.env.GRAPHITI_TOKEN_TEST = "secret-token";

  globalThis.fetch = async (_url, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const payload = JSON.parse(rawBody);
    const headers = normalizeHeaders(init?.headers);
    const method = payload?.method;
    seenMethods.push(method);

    assert.equal(headers.authorization, "Bearer secret-token");

    if (method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-abc",
          },
        },
      );
    }

    if (method === "notifications/initialized") {
      assert.equal(headers["mcp-session-id"], "session-abc");
      return new Response("", { status: 202 });
    }

    if (method === "tools/list") {
      assert.equal(headers["mcp-session-id"], "session-abc");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            tools: [{ name: "search_nodes" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (method === "tools/call") {
      assert.equal(headers["mcp-session-id"], "session-abc");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { ok: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32601, message: `Unhandled method: ${String(method)}` },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new GraphitiMcpClient({
      baseUrl: "http://127.0.0.1:8000",
      timeoutMs: 1000,
      transport: "mcp",
      auth: {
        tokenEnv: "GRAPHITI_TOKEN_TEST",
        headerName: "authorization",
      },
    });

    const tools = await client.discoverTools();
    assert.equal(tools.length, 1);

    const result = await client.callTool("search_nodes", { query: "alice" });
    assert.deepEqual(result, { ok: true });

    assert.deepEqual(seenMethods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnv === undefined) {
      delete process.env.GRAPHITI_TOKEN_TEST;
    } else {
      process.env.GRAPHITI_TOKEN_TEST = previousEnv;
    }
  }
});
