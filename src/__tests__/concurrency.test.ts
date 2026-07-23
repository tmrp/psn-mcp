import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../psn/concurrency.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("mapWithConcurrency preserves input order and never exceeds the limit", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let active = 0;
  let peak = 0;

  const results = await mapWithConcurrency(items, 4, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await delay(5);
    active--;
    return n * 2;
  });

  assert.equal(
    peak,
    4,
    `peak concurrency ${peak} should reach but not exceed 4`,
  );
  assert.deepEqual(
    results,
    items.map((n) => n * 2),
  );
});

test("mapWithConcurrency handles an empty list without running the worker", async () => {
  const results = await mapWithConcurrency([], 4, async () => {
    throw new Error("should not be called");
  });
  assert.deepEqual(results, []);
});

test("mapWithConcurrency caps workers at the number of items", async () => {
  let peak = 0;
  let active = 0;
  await mapWithConcurrency([1, 2], 8, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await delay(5);
    active--;
    return n;
  });
  assert.equal(peak, 2);
});

test("mapWithConcurrency rejects a limit below 1", async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (n) => n),
    /at least 1/,
  );
});
