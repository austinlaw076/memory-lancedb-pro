import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { applyPromotionPolicy } = jiti("../src/promotion-policy.ts");

test("promotion policy queues low-confidence inferred entries", () => {
  const rows = [
    {
      id: "a1",
      text: "[graph-inferred] Alice prefers tea",
      category: "preference",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: JSON.stringify({ assertionKind: "inferred", confidence: 0.65 }),
    },
  ];

  const result = applyPromotionPolicy(rows);
  assert.equal(result.promotedByTarget.USER.length, 0);
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].reason, "low_confidence_inferred");
});

test("promotion policy detects contradictions and blocks promotion", () => {
  const now = Date.now();
  const rows = [
    {
      id: "p1",
      text: "Alice likes tea",
      category: "preference",
      scope: "global",
      importance: 0.8,
      timestamp: now,
      metadata: "{}",
    },
    {
      id: "p2",
      text: "Alice does not like tea",
      category: "preference",
      scope: "global",
      importance: 0.8,
      timestamp: now + 1,
      metadata: "{}",
    },
  ];

  const result = applyPromotionPolicy(rows);
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.promotedByTarget.USER.length, 0);
  assert.equal(result.queue.length, 2);
  assert.equal(result.queue[0].reason, "contradiction_detected");
});
