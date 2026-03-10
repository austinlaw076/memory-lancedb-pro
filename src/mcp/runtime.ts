import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parsePluginConfig } from "../../index.js";
import { AccessTracker } from "../access-tracker.js";
import { createEmbedder, getVectorDimensions } from "../embedder.js";
import {
  createGraphitiBridge,
  type GraphitiBridge,
} from "../graphiti/bridge.js";
import {
  createGraphitiSyncService,
  type GraphitiSyncService,
} from "../graphiti/sync.js";
import { isNoise } from "../noise-filter.js";
import { getDisplayCategoryTag } from "../reflection-metadata.js";
import {
  createRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type MemoryRetriever,
} from "../retriever.js";
import { MemoryScopeManager, type ScopeManager } from "../scopes.js";
import {
  MemoryStore,
  validateStoragePath,
  type MemoryEntry,
} from "../store.js";
import { createFileLogger, type FileLogger } from "./file-logger.mjs";

interface OpenClawConfig {
  plugins?: {
    entries?: Record<string, { enabled?: boolean; config?: unknown }>;
  };
}

export interface RuntimeOptions {
  openclawConfigPath?: string;
  pluginEntryName?: string;
  defaultScope?: string;
  accessMode?: "all" | "scoped";
}

export interface McpToolResult {
  content: string;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MemoryMcpRuntime {
  store: MemoryStore;
  retriever: MemoryRetriever;
  embedder: ReturnType<typeof createEmbedder>;
  scopeManager: ScopeManager;
  graphitiBridge?: GraphitiBridge;
  graphitiSync?: GraphitiSyncService;
  logger: FileLogger;
  accessMode: "all" | "scoped";
  defaultScope: string;
  pluginConfigPath: string;
  pluginEntryName: string;
  toolStore(args: Record<string, unknown>): Promise<McpToolResult>;
  toolRecall(args: Record<string, unknown>): Promise<McpToolResult>;
  toolUpdate(args: Record<string, unknown>): Promise<McpToolResult>;
  toolForget(args: Record<string, unknown>): Promise<McpToolResult>;
  toolGraphRecall(args: Record<string, unknown>): Promise<McpToolResult>;
}

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function clamp01(value: unknown, fallback = 0.7): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function isFullUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
}

function safeParseJson(value: string | undefined): Record<string, unknown> {
  if (!value || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function sanitizeMemoryEntry(entry: MemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    text: entry.text,
    category: entry.category,
    scope: entry.scope,
    importance: entry.importance,
    timestamp: entry.timestamp,
    metadata: safeParseJson(entry.metadata),
  };
}

function sanitizeRetrievalResult(result: any): Record<string, unknown> {
  return {
    score: result.score,
    entry: sanitizeMemoryEntry(result.entry),
    sources: result.sources,
  };
}

function extractPluginConfig(configPath: string, pluginEntryName: string): unknown {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as OpenClawConfig;
  return parsed.plugins?.entries?.[pluginEntryName]?.config;
}

function resolveDbPath(configPath: string, dbPath: string): string {
  const expanded = expandHome(dbPath);
  return isAbsolute(expanded) ? expanded : resolve(dirname(configPath), expanded);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createMemoryMcpRuntime(
  options: RuntimeOptions = {},
): Promise<MemoryMcpRuntime> {
  const pluginEntryName = options.pluginEntryName || process.env.MEMORY_LANCEDB_PRO_MCP_PLUGIN_ENTRY || "memory-lancedb-pro";
  const configPath = resolve(expandHome(options.openclawConfigPath || process.env.MEMORY_LANCEDB_PRO_MCP_OPENCLAW_CONFIG || "~/.openclaw/openclaw.json"));
  const rawPluginConfig = extractPluginConfig(configPath, pluginEntryName);
  const parsedPluginConfig = parsePluginConfig(rawPluginConfig);

  if (!parsedPluginConfig.embedding) {
    throw new Error("memory-lancedb-pro MCP: embedding config is required");
  }

  const logger = createFileLogger("mcp.log.jsonl");
  const trace = () => `mem_${randomUUID().slice(0, 8)}`;
  const dbPath = validateStoragePath(
    resolveDbPath(configPath, parsedPluginConfig.dbPath || join(homedir(), ".openclaw", "workspace", "memory", "lancedb-pro")),
  );
  const vectorDim = getVectorDimensions(
    parsedPluginConfig.embedding.model,
    parsedPluginConfig.embedding.dimensions,
  );

  const embedder = createEmbedder(parsedPluginConfig.embedding);
  const store = new MemoryStore({ dbPath, vectorDim });
  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(parsedPluginConfig.retrieval || {}),
  });

  const accessTracker = new AccessTracker(store, {
    enabled: parsedPluginConfig.accessTracking?.enabled,
    manualRecallBoost: parsedPluginConfig.accessTracking?.manualRecallBoost,
    maxBoost: parsedPluginConfig.accessTracking?.maxBoost,
  });
  retriever.setAccessTracker(accessTracker);

  const scopeManager = new MemoryScopeManager(parsedPluginConfig.scopes || {});

  const graphitiBridge = parsedPluginConfig.graphiti?.enabled
    ? createGraphitiBridge({
        config: parsedPluginConfig.graphiti,
        logger: {
          warn: (message: string) => logger.warn("graphiti_warn", { message }),
        },
      })
    : undefined;

  const graphitiSync = graphitiBridge
    ? createGraphitiSyncService({
        bridge: graphitiBridge,
        config: parsedPluginConfig.graphiti,
        store,
        logger: {
          warn: (message: string) => logger.warn("graphiti_sync_warn", { message }),
        },
      })
    : undefined;

  const accessMode = options.accessMode || (process.env.MEMORY_LANCEDB_PRO_MCP_ACCESS_MODE === "scoped" ? "scoped" : "all");
  const defaultScope = options.defaultScope || process.env.MEMORY_LANCEDB_PRO_MCP_DEFAULT_SCOPE || parsedPluginConfig.scopes?.default || "global";

  logger.info("runtime_initialized", {
    configPath,
    pluginEntryName,
    dbPath,
    accessMode,
    defaultScope,
    graphitiEnabled: !!parsedPluginConfig.graphiti?.enabled,
  });

  function resolveScopeFilter(requestedScope?: string): string[] | undefined {
    if (requestedScope) {
      if (!scopeManager.validateScope(requestedScope)) {
        throw new Error(`Invalid scope: ${requestedScope}`);
      }
      return [requestedScope];
    }
    return accessMode === "all" ? undefined : scopeManager.getAccessibleScopes();
  }

  function resolveTargetScope(requestedScope?: string): string {
    const target = requestedScope || defaultScope;
    if (!scopeManager.validateScope(target)) {
      throw new Error(`Invalid scope: ${target}`);
    }
    return target;
  }

  async function toolStore(args: Record<string, unknown>): Promise<McpToolResult> {
    const traceId = trace();
    const startedAt = Date.now();
    const text = String(args.text || "").trim();
    const category = String(args.category || "other") as MemoryEntry["category"];
    const importance = clamp01(args.importance, 0.7);
    const scope = args.scope ? String(args.scope) : undefined;

    logger.info("tool_call", { traceId, tool: "memory_store", scope: scope || defaultScope, category });

    try {
      if (!text) {
        return {
          content: "Memory storage failed: text is required.",
          structuredContent: { error: "missing_text" },
          isError: true,
        };
      }

      const targetScope = resolveTargetScope(scope);

      if (isNoise(text)) {
        logger.info("tool_result", {
          traceId,
          tool: "memory_store",
          action: "noise_filtered",
          latencyMs: Date.now() - startedAt,
        });
        return {
          content: "Skipped: text detected as noise.",
          structuredContent: { action: "noise_filtered" },
        };
      }

      const vector = await embedder.embedPassage(text);

      let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
      try {
        existing = await store.vectorSearch(vector, 1, 0.1, [targetScope]);
      } catch (error) {
        logger.warn("duplicate_precheck_failed", {
          traceId,
          tool: "memory_store",
          error,
        });
      }

      if (existing.length > 0 && existing[0].score > 0.98) {
        const duplicate = existing[0].entry;
        logger.info("tool_result", {
          traceId,
          tool: "memory_store",
          action: "duplicate",
          existingId: duplicate.id,
          latencyMs: Date.now() - startedAt,
        });
        return {
          content: `Similar memory already exists: \"${duplicate.text}\"`,
          structuredContent: {
            action: "duplicate",
            existing: sanitizeMemoryEntry(duplicate),
            similarity: existing[0].score,
          },
        };
      }

      const entry = await store.store({
        text,
        vector,
        importance,
        category,
        scope: targetScope,
      });

      const graphiti = await graphitiSync?.syncMemory(
        {
          id: entry.id,
          text: entry.text,
          scope: entry.scope,
          category: entry.category,
          metadata: entry.metadata,
        },
        {
          mode: "memoryStore",
          source: "memory_store",
          mutation: "memory_store",
        },
      );

      logger.info("tool_result", {
        traceId,
        tool: "memory_store",
        action: "created",
        memoryId: entry.id,
        scope: entry.scope,
        latencyMs: Date.now() - startedAt,
      });

      return {
        content: `Stored: \"${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""}\" in scope '${entry.scope}'`,
        structuredContent: {
          action: "created",
          memory: sanitizeMemoryEntry(entry),
          graphiti,
        },
      };
    } catch (error) {
      logger.error("tool_error", {
        traceId,
        tool: "memory_store",
        error,
        latencyMs: Date.now() - startedAt,
      });
      return {
        content: `Memory storage failed: ${summarizeError(error)}`,
        structuredContent: { error: "store_failed", message: summarizeError(error) },
        isError: true,
      };
    }
  }

  async function toolRecall(args: Record<string, unknown>): Promise<McpToolResult> {
    const traceId = trace();
    const startedAt = Date.now();
    const query = String(args.query || "").trim();
    const limit = clampInt(args.limit, 1, 20, 5);
    const scope = args.scope ? String(args.scope) : undefined;
    const category = args.category ? String(args.category) : undefined;

    logger.info("tool_call", { traceId, tool: "memory_recall", query, limit, scope, category });

    try {
      if (!query) {
        return {
          content: "Memory recall failed: query is required.",
          structuredContent: { error: "missing_query" },
          isError: true,
        };
      }

      const scopeFilter = resolveScopeFilter(scope);
      const results = await retriever.retrieve({
        query,
        limit,
        scopeFilter,
        category,
        source: "manual",
      });

      logger.info("tool_result", {
        traceId,
        tool: "memory_recall",
        count: results.length,
        scopes: scopeFilter,
        latencyMs: Date.now() - startedAt,
      });

      if (results.length === 0) {
        return {
          content: "No relevant memories found.",
          structuredContent: { count: 0, query, scopes: scopeFilter || "all" },
        };
      }

      const lines = results.map((result, index) => {
        const sources: string[] = [];
        if (result.sources.vector) sources.push("vector");
        if (result.sources.bm25) sources.push("BM25");
        if (result.sources.reranked) sources.push("reranked");
        const categoryTag = getDisplayCategoryTag(result.entry);
        return `${index + 1}. [${result.entry.id}] [${categoryTag}] ${result.entry.text} (${(result.score * 100).toFixed(0)}%${sources.length ? `, ${sources.join("+")}` : ""})`;
      }).join("\n");

      return {
        content: `Found ${results.length} memories:\n\n${lines}`,
        structuredContent: {
          count: results.length,
          query,
          scopes: scopeFilter || "all",
          retrievalMode: retriever.getConfig().mode,
          memories: results.map(sanitizeRetrievalResult),
        },
      };
    } catch (error) {
      logger.error("tool_error", {
        traceId,
        tool: "memory_recall",
        error,
        latencyMs: Date.now() - startedAt,
      });
      return {
        content: `Memory recall failed: ${summarizeError(error)}`,
        structuredContent: { error: "recall_failed", message: summarizeError(error) },
        isError: true,
      };
    }
  }

  async function toolUpdate(args: Record<string, unknown>): Promise<McpToolResult> {
    const traceId = trace();
    const startedAt = Date.now();
    const memoryId = String(args.memoryId || "").trim();
    const text = typeof args.text === "string" ? args.text.trim() : undefined;
    const category = typeof args.category === "string" ? args.category : undefined;
    const importance = args.importance;

    logger.info("tool_call", { traceId, tool: "memory_update", memoryId });

    try {
      if (!memoryId) {
        return {
          content: "Memory update failed: memoryId is required.",
          structuredContent: { error: "missing_memory_id" },
          isError: true,
        };
      }
      if (!text && importance === undefined && !category) {
        return {
          content: "Nothing to update. Provide at least one of: text, importance, category.",
          structuredContent: { error: "no_updates" },
          isError: true,
        };
      }

      let resolvedId = memoryId;
      const scopeFilter = resolveScopeFilter();
      const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);

      if (!uuidLike) {
        const candidates = await retriever.retrieve({
          query: memoryId,
          limit: 3,
          scopeFilter,
        });
        if (candidates.length === 0) {
          return {
            content: `No memory found matching \"${memoryId}\".`,
            structuredContent: { error: "not_found", query: memoryId },
            isError: true,
          };
        }
        if (candidates.length === 1 || candidates[0].score > 0.85) {
          resolvedId = candidates[0].entry.id;
        } else {
          return {
            content: `Multiple matches. Specify memoryId:\n${candidates.map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`).join("\n")}`,
            structuredContent: {
              action: "candidates",
              candidates: candidates.map(sanitizeRetrievalResult),
            },
          };
        }
      }

      let vector: number[] | undefined;
      if (text) {
        if (isNoise(text)) {
          return {
            content: "Skipped: updated text detected as noise.",
            structuredContent: { action: "noise_filtered" },
          };
        }
        vector = await embedder.embedPassage(text);
      }

      const updates: Record<string, unknown> = {};
      if (text) updates.text = text;
      if (vector) updates.vector = vector;
      if (importance !== undefined) updates.importance = clamp01(importance, 0.7);
      if (category) updates.category = category;

      const updated = await store.update(resolvedId, updates, scopeFilter);
      if (!updated) {
        return {
          content: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
          structuredContent: { error: "not_found", id: resolvedId },
          isError: true,
        };
      }

      const graphiti = await graphitiSync?.syncMemory(
        {
          id: updated.id,
          text: updated.text,
          scope: updated.scope,
          category: updated.category,
          metadata: updated.metadata,
        },
        {
          mode: "memoryStore",
          source: "memory_update",
          mutation: "memory_update",
          extraMetadata: {
            fieldsUpdated: Object.keys(updates),
          },
        },
      );

      logger.info("tool_result", {
        traceId,
        tool: "memory_update",
        memoryId: updated.id,
        scope: updated.scope,
        fieldsUpdated: Object.keys(updates),
        latencyMs: Date.now() - startedAt,
      });

      return {
        content: `Updated memory ${updated.id.slice(0, 8)}...: \"${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}\"`,
        structuredContent: {
          action: "updated",
          memory: sanitizeMemoryEntry(updated),
          fieldsUpdated: Object.keys(updates),
          graphiti,
        },
      };
    } catch (error) {
      logger.error("tool_error", {
        traceId,
        tool: "memory_update",
        error,
        latencyMs: Date.now() - startedAt,
      });
      return {
        content: `Memory update failed: ${summarizeError(error)}`,
        structuredContent: { error: "update_failed", message: summarizeError(error) },
        isError: true,
      };
    }
  }

  async function toolForget(args: Record<string, unknown>): Promise<McpToolResult> {
    const traceId = trace();
    const startedAt = Date.now();
    const query = typeof args.query === "string" ? args.query.trim() : undefined;
    const memoryId = typeof args.memoryId === "string" ? args.memoryId.trim() : undefined;
    const scope = typeof args.scope === "string" ? args.scope.trim() : undefined;

    logger.info("tool_call", { traceId, tool: "memory_forget", query, memoryId, scope });

    try {
      const scopeFilter = resolveScopeFilter(scope);

      const recordForget = async (payload: {
        memoryId: string;
        scope: string;
        text?: string;
        mode: "memoryId" | "query-auto";
      }) => {
        return await graphitiSync?.recordEvent({
          mode: "memoryStore",
          source: "memory_forget",
          scope: payload.scope,
          text: payload.text
            ? `Memory forgotten: ${payload.text}`
            : `Memory forgotten: id=${payload.memoryId}`,
          metadata: {
            mode: payload.mode,
            memoryId: payload.memoryId,
          },
        });
      };

      if (memoryId) {
        let originalScope = scope || defaultScope;
        let originalText: string | undefined;
        if (isFullUuid(memoryId)) {
          try {
            const existing = await store.getById(memoryId);
            if (existing) {
              originalScope = existing.scope;
              originalText = existing.text;
            }
          } catch {
            // ignore
          }
        }

        const deleted = await store.delete(memoryId, scopeFilter);
        if (!deleted) {
          return {
            content: `Memory ${memoryId} not found or access denied.`,
            structuredContent: { error: "not_found", id: memoryId },
            isError: true,
          };
        }

        const graphiti = await recordForget({
          memoryId,
          scope: originalScope,
          text: originalText,
          mode: "memoryId",
        });

        logger.info("tool_result", {
          traceId,
          tool: "memory_forget",
          action: "deleted",
          memoryId,
          latencyMs: Date.now() - startedAt,
        });

        return {
          content: `Memory ${memoryId} forgotten.`,
          structuredContent: {
            action: "deleted",
            id: memoryId,
            graphiti,
          },
        };
      }

      if (query) {
        const results = await retriever.retrieve({
          query,
          limit: 5,
          scopeFilter,
        });

        if (results.length === 0) {
          return {
            content: "No matching memories found.",
            structuredContent: { found: 0, query },
          };
        }

        if (results.length === 1 && results[0].score > 0.9) {
          const candidate = results[0].entry;
          const deleted = await store.delete(candidate.id, scopeFilter);
          if (deleted) {
            const graphiti = await recordForget({
              memoryId: candidate.id,
              scope: candidate.scope,
              text: candidate.text,
              mode: "query-auto",
            });
            return {
              content: `Forgotten: \"${candidate.text}\"`,
              structuredContent: {
                action: "deleted",
                id: candidate.id,
                graphiti,
              },
            };
          }
        }

        return {
          content: `Found ${results.length} candidates. Specify memoryId to delete:\n${results.map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`).join("\n")}`,
          structuredContent: {
            action: "candidates",
            candidates: results.map(sanitizeRetrievalResult),
          },
        };
      }

      return {
        content: "Provide either 'query' to search for memories or 'memoryId' to delete a specific memory.",
        structuredContent: { error: "missing_param" },
        isError: true,
      };
    } catch (error) {
      logger.error("tool_error", {
        traceId,
        tool: "memory_forget",
        error,
        latencyMs: Date.now() - startedAt,
      });
      return {
        content: `Memory deletion failed: ${summarizeError(error)}`,
        structuredContent: { error: "delete_failed", message: summarizeError(error) },
        isError: true,
      };
    }
  }

  async function toolGraphRecall(args: Record<string, unknown>): Promise<McpToolResult> {
    const traceId = trace();
    const startedAt = Date.now();
    const query = String(args.query || "").trim();
    const scope = typeof args.scope === "string" ? args.scope.trim() : undefined;
    const limitNodes = clampInt(args.limitNodes, 1, 30, 6);
    const limitFacts = clampInt(args.limitFacts, 1, 30, 10);

    logger.info("tool_call", {
      traceId,
      tool: "memory_graph_recall",
      query,
      scope,
      limitNodes,
      limitFacts,
    });

    try {
      if (!graphitiBridge) {
        return {
          content: "Graphiti recall is disabled.",
          structuredContent: { error: "graphiti_disabled" },
          isError: true,
        };
      }

      if (!query) {
        return {
          content: "Graph recall failed: query is required.",
          structuredContent: { error: "missing_query" },
          isError: true,
        };
      }

      const targetScope = resolveTargetScope(scope);
      const result = await graphitiBridge.recall({
        query,
        scope: targetScope,
        limitNodes,
        limitFacts,
      });

      logger.info("tool_result", {
        traceId,
        tool: "memory_graph_recall",
        scope: targetScope,
        nodeCount: result.nodes.length,
        factCount: result.facts.length,
        latencyMs: Date.now() - startedAt,
      });

      return {
        content:
          `Graph recall for scope \"${targetScope}\" (group_ids=\"${result.groupIds.join(",")}\")\n\n` +
          `Nodes:\n${result.nodes.length ? result.nodes.map((node, index) => `${index + 1}. ${node.label}`).join("\n") : "none"}\n\n` +
          `Facts:\n${result.facts.length ? result.facts.map((fact, index) => `${index + 1}. ${fact.text}`).join("\n") : "none"}`,
        structuredContent: {
          scope: targetScope,
          query,
          groupIds: result.groupIds,
          nodes: result.nodes,
          facts: result.facts,
        },
      };
    } catch (error) {
      logger.error("tool_error", {
        traceId,
        tool: "memory_graph_recall",
        error,
        latencyMs: Date.now() - startedAt,
      });
      return {
        content: `Graph recall failed: ${summarizeError(error)}`,
        structuredContent: { error: "graph_recall_failed", message: summarizeError(error) },
        isError: true,
      };
    }
  }

  return {
    store,
    retriever,
    embedder,
    scopeManager,
    graphitiBridge,
    graphitiSync,
    logger,
    accessMode,
    defaultScope,
    pluginConfigPath: configPath,
    pluginEntryName,
    toolStore,
    toolRecall,
    toolUpdate,
    toolForget,
    toolGraphRecall,
  };
}
