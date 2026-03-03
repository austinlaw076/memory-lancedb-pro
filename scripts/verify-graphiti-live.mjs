#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENV = {
  baseUrl: process.env.GRAPHITI_BASE_URL?.trim() || "http://localhost:8000",
  token: process.env.GRAPHITI_API_TOKEN?.trim() || "",
  timeoutMs: parsePositiveInt(process.env.GRAPHITI_TIMEOUT_MS, 5000),
  scope: process.env.GRAPHITI_SCOPE?.trim() || "global",
  query: process.env.GRAPHITI_QUERY?.trim() || "project timeline and owner preferences",
  text:
    process.env.GRAPHITI_TEST_TEXT?.trim() ||
    `Graphiti live verification at ${new Date().toISOString()} for scope/global mapping.`,
};

const TOOL_CANDIDATES = {
  addEpisode: ["add_episode", "graphiti_add_episode"],
  searchNodes: ["search_nodes", "graphiti_search_nodes"],
  searchFacts: ["search_facts", "graphiti_search_facts"],
};

async function main() {
  const startedAt = new Date();
  const report = {
    timestamp: startedAt.toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      baseUrl: ENV.baseUrl,
      hasToken: ENV.token.length > 0,
      timeoutMs: ENV.timeoutMs,
      scope: ENV.scope,
      query: ENV.query,
    },
    steps: [],
    summary: {
      status: "pending",
      notes: [],
    },
  };

  const healthResult = await probeHealth(ENV.baseUrl, ENV.timeoutMs);
  report.steps.push({
    name: "health_probe",
    ...healthResult,
  });

  const mcpProbe = await probeMcpTools(ENV.baseUrl, ENV.token, ENV.timeoutMs);
  report.steps.push({
    name: "mcp_tools_list",
    ...mcpProbe,
  });

  if (!mcpProbe.ok) {
    if (mcpProbe.authRequired && !ENV.token) {
      report.summary.status = "blocked_auth";
      report.summary.notes.push(
        "Graphiti MCP endpoint requires authentication. Set GRAPHITI_API_TOKEN and rerun.",
      );
    } else {
      report.summary.status = "fail";
      report.summary.notes.push("Unable to list MCP tools from Graphiti endpoint.");
    }
    await writeReports(report);
    printSummary(report);
    process.exitCode = 1;
    return;
  }

  const tools = Array.isArray(mcpProbe.tools) ? mcpProbe.tools : [];
  const toolNames = tools
    .map((tool) => (tool && typeof tool === "object" ? tool.name : ""))
    .filter((name) => typeof name === "string" && name.length > 0);

  const addEpisodeTool = firstMatching(toolNames, TOOL_CANDIDATES.addEpisode);
  const searchNodesTool = firstMatching(toolNames, TOOL_CANDIDATES.searchNodes);
  const searchFactsTool = firstMatching(toolNames, TOOL_CANDIDATES.searchFacts);

  report.steps.push({
    name: "tool_resolution",
    ok: Boolean(addEpisodeTool && searchNodesTool && searchFactsTool),
    toolsAvailable: toolNames,
    resolved: {
      addEpisodeTool,
      searchNodesTool,
      searchFactsTool,
    },
  });

  const writeStep = addEpisodeTool
    ? await verifyAddEpisode(ENV.baseUrl, ENV.token, ENV.timeoutMs, addEpisodeTool, ENV.scope, ENV.text)
    : {
        ok: false,
        error: `Missing tool: ${TOOL_CANDIDATES.addEpisode.join(" | ")}`,
      };
  report.steps.push({
    name: "add_episode",
    ...writeStep,
  });

  const nodesStep = searchNodesTool
    ? await verifySearchTool(
        ENV.baseUrl,
        ENV.token,
        ENV.timeoutMs,
        searchNodesTool,
        ENV.scope,
        ENV.query,
        6,
        "nodes",
      )
    : {
        ok: false,
        error: `Missing tool: ${TOOL_CANDIDATES.searchNodes.join(" | ")}`,
      };
  report.steps.push({
    name: "search_nodes",
    ...nodesStep,
  });

  const factsStep = searchFactsTool
    ? await verifySearchTool(
        ENV.baseUrl,
        ENV.token,
        ENV.timeoutMs,
        searchFactsTool,
        ENV.scope,
        ENV.query,
        10,
        "facts",
      )
    : {
        ok: false,
        error: `Missing tool: ${TOOL_CANDIDATES.searchFacts.join(" | ")}`,
      };
  report.steps.push({
    name: "search_facts",
    ...factsStep,
  });

  const failed = report.steps.filter((step) => step.ok === false);
  if (failed.length === 0) {
    report.summary.status = "pass";
    report.summary.notes.push("Graphiti live verification passed.");
  } else {
    report.summary.status = "partial";
    report.summary.notes.push(`Some checks failed: ${failed.map((s) => s.name).join(", ")}`);
  }

  await writeReports(report);
  printSummary(report);
  process.exitCode = report.summary.status === "pass" ? 0 : 1;
}

async function probeHealth(baseUrl, timeoutMs) {
  const candidates = ["/health", "/api/health", "/status"];
  const details = [];
  for (const path of candidates) {
    const url = `${stripTrailingSlash(baseUrl)}${path}`;
    const result = await request(url, {
      method: "GET",
      timeoutMs,
      token: "",
    });
    details.push({
      url,
      ok: result.ok,
      status: result.status,
      bodySnippet: snippet(result.bodyText),
      latencyMs: result.latencyMs,
    });
    if (result.ok) {
      return {
        ok: true,
        details,
      };
    }
  }
  return {
    ok: false,
    details,
    warning: "No health endpoint returned 2xx. This may be acceptable if /mcp is reachable.",
  };
}

async function probeMcpTools(baseUrl, token, timeoutMs) {
  const endpoints = ["/mcp", "/mcp/"];
  const attempts = [];
  for (const suffix of endpoints) {
    const url = `${stripTrailingSlash(baseUrl)}${suffix}`;
    const response = await mcpCall(url, token, timeoutMs, "tools/list", {});
    attempts.push({
      url,
      ok: response.ok,
      status: response.status,
      authRequired: response.authRequired,
      latencyMs: response.latencyMs,
      bodySnippet: snippet(response.bodyText),
    });
    if (response.ok && Array.isArray(response.result?.tools)) {
      return {
        ok: true,
        endpoint: url,
        tools: response.result.tools,
        attempts,
      };
    }
    if (response.authRequired) {
      return {
        ok: false,
        authRequired: true,
        endpoint: url,
        attempts,
      };
    }
  }
  return {
    ok: false,
    attempts,
  };
}

async function verifyAddEpisode(baseUrl, token, timeoutMs, toolName, scope, text) {
  const endpoint = `${stripTrailingSlash(baseUrl)}/mcp`;
  const payloads = [
    { group_id: scope, text },
    { groupId: scope, text },
    { group_id: scope, messages: [{ role: "user", content: text }] },
    { group_id: scope, episode_body: { text } },
  ];

  const attempts = [];
  for (const args of payloads) {
    const response = await mcpCall(endpoint, token, timeoutMs, "tools/call", {
      name: toolName,
      arguments: args,
    });

    attempts.push({
      args,
      ok: response.ok,
      status: response.status,
      latencyMs: response.latencyMs,
      bodySnippet: snippet(response.bodyText),
    });

    if (response.ok) {
      return {
        ok: true,
        tool: toolName,
        attempts,
        episodeRef: extractEpisodeRef(response.result),
      };
    }
  }
  return {
    ok: false,
    tool: toolName,
    attempts,
  };
}

async function verifySearchTool(baseUrl, token, timeoutMs, toolName, scope, query, limit, kind) {
  const endpoint = `${stripTrailingSlash(baseUrl)}/mcp`;
  const payloads = [
    { group_id: scope, query, limit },
    { groupId: scope, query, limit },
    { group_id: scope, q: query, top_k: limit },
  ];

  const attempts = [];
  for (const args of payloads) {
    const response = await mcpCall(endpoint, token, timeoutMs, "tools/call", {
      name: toolName,
      arguments: args,
    });
    attempts.push({
      args,
      ok: response.ok,
      status: response.status,
      latencyMs: response.latencyMs,
      bodySnippet: snippet(response.bodyText),
    });

    if (response.ok) {
      return {
        ok: true,
        tool: toolName,
        attempts,
        itemCountHint: estimateResultCount(response.result, kind),
      };
    }
  }
  return {
    ok: false,
    tool: toolName,
    attempts,
  };
}

async function mcpCall(endpoint, token, timeoutMs, method, params) {
  const payload = {
    jsonrpc: "2.0",
    id: `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  };
  const result = await request(endpoint, {
    method: "POST",
    timeoutMs,
    token,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });

  let parsed;
  try {
    parsed = result.bodyText ? JSON.parse(result.bodyText) : undefined;
  } catch {
    parsed = undefined;
  }

  const authRequired =
    parsed?.error === "invalid_token" ||
    parsed?.error?.code === 401 ||
    /invalid_token|Authentication required/i.test(result.bodyText || "");

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      bodyText: result.bodyText,
      authRequired,
    };
  }

  if (parsed?.error) {
    return {
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      bodyText: result.bodyText,
      authRequired,
      result: parsed?.result,
    };
  }

  return {
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    bodyText: result.bodyText,
    result: parsed?.result,
    authRequired: false,
  };
}

async function request(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();
  try {
    const headers = { ...(options.headers || {}) };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      bodyText,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      bodyText: String(err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeReports(report) {
  const stamp = toStamp(new Date(report.timestamp));
  const dir = join("docs", "reports", "graphiti-live");
  await mkdir(dir, { recursive: true });

  const jsonPath = join(dir, `graphiti-live-${stamp}.json`);
  const mdPath = join(dir, `graphiti-live-${stamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await writeFile(mdPath, renderMarkdown(report, jsonPath), "utf-8");
  report.summary.jsonPath = jsonPath;
  report.summary.markdownPath = mdPath;
}

function renderMarkdown(report, jsonPath) {
  const lines = [];
  lines.push(`# Graphiti Live Verification Report`);
  lines.push("");
  lines.push(`- Timestamp: ${report.timestamp}`);
  lines.push(`- Status: **${String(report.summary.status).toUpperCase()}**`);
  lines.push(`- Base URL: \`${report.config.baseUrl}\``);
  lines.push(`- Token provided: ${report.config.hasToken ? "yes" : "no"}`);
  lines.push(`- Raw JSON: \`${jsonPath}\``);
  lines.push("");

  lines.push("## Step Results");
  lines.push("");
  for (const step of report.steps) {
    lines.push(`### ${step.name}`);
    lines.push(`- ok: ${step.ok === true ? "yes" : "no"}`);
    if (step.warning) lines.push(`- warning: ${step.warning}`);
    if (step.error) lines.push(`- error: ${step.error}`);
    if (step.endpoint) lines.push(`- endpoint: \`${step.endpoint}\``);
    if (step.resolved) lines.push(`- resolved: \`${JSON.stringify(step.resolved)}\``);
    if (step.episodeRef) lines.push(`- episodeRef: \`${step.episodeRef}\``);
    if (typeof step.itemCountHint === "number") lines.push(`- result count hint: ${step.itemCountHint}`);
    if (Array.isArray(step.attempts)) {
      lines.push("- attempts:");
      for (const attempt of step.attempts) {
        lines.push(
          `  - status=${attempt.status} ok=${attempt.ok ? "yes" : "no"} latency=${attempt.latencyMs}ms snippet=${JSON.stringify(
            snippet(attempt.bodySnippet || ""),
          )}`,
        );
      }
    }
    lines.push("");
  }

  if (Array.isArray(report.summary.notes) && report.summary.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of report.summary.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function printSummary(report) {
  console.log(`Graphiti verification status: ${String(report.summary.status).toUpperCase()}`);
  if (report.summary.markdownPath) {
    console.log(`Markdown report: ${report.summary.markdownPath}`);
  }
  if (report.summary.jsonPath) {
    console.log(`JSON report: ${report.summary.jsonPath}`);
  }
}

function firstMatching(names, candidates) {
  for (const candidate of candidates) {
    if (names.includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractEpisodeRef(result) {
  const payload = extractStructuredPayload(result);
  for (const key of ["episode_id", "episodeId", "id", "ref"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function extractStructuredPayload(result) {
  if (!result || typeof result !== "object") {
    return {};
  }
  const record = result;
  if (record.structuredContent && typeof record.structuredContent === "object") {
    return record.structuredContent;
  }
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed && typeof parsed === "object") {
            return parsed;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return record;
}

function estimateResultCount(result, kind) {
  const payload = extractStructuredPayload(result);
  for (const key of [kind, "items", "results", "data"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return 0;
}

function snippet(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length > 280 ? `${raw.slice(0, 280)}...` : raw;
}

function parsePositiveInt(raw, fallback) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function toStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");
}

main().catch((err) => {
  console.error(`Graphiti verification script failed: ${String(err)}`);
  process.exitCode = 1;
});
