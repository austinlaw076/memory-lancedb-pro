import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildGraphReflectionContext } = jiti("../src/graphiti/reflection.ts");

test("buildGraphReflectionContext builds context and inferred candidates", async () => {
  const result = await buildGraphReflectionContext({
    enabled: true,
    scope: "global",
    conversation: "user: We are working on Alice preference notes and tea setup.",
    limitNodes: 6,
    limitFacts: 10,
    bridge: {
      recall: async () => ({
        groupIds: ["user", "knowledge"],
        nodes: [{ label: "Alice" }, { label: "Tea" }],
        facts: [{ text: "Alice likes tea" }],
      }),
    },
  });

  assert.ok(result);
  assert.deepEqual(result.groupIds, ["user", "knowledge"]);
  assert.match(result.contextBlock, /<graph-context>/);
  assert.match(result.contextBlock, /group_ids: user,knowledge/);
  assert.match(result.contextBlock, /Alice likes tea/);
  assert.equal(result.inferredCandidates.length, 1);
  assert.match(result.inferredCandidates[0].text, /Alice likes tea/i);
});

test("buildGraphReflectionContext returns undefined when graph disabled or empty", async () => {
  const disabled = await buildGraphReflectionContext({
    enabled: false,
    scope: "global",
    conversation: "hello",
    limitNodes: 6,
    limitFacts: 10,
    bridge: {
      recall: async () => ({
        groupIds: ["global"],
        nodes: [{ label: "X" }],
        facts: [{ text: "X likes Y" }],
      }),
    },
  });
  assert.equal(disabled, undefined);

  const empty = await buildGraphReflectionContext({
    enabled: true,
    scope: "global",
    conversation: "hello",
    limitNodes: 6,
    limitFacts: 10,
    bridge: {
      recall: async () => ({
        groupIds: ["global"],
        nodes: [],
        facts: [],
      }),
    },
  });
  assert.equal(empty, undefined);
});
