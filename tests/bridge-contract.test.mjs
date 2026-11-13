// Contract regression for the App<->Engine bridge handshake.
// Pure module import (no npm, no cordis harness needed):
//   node --test tests/bridge-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../bridge/dsh-compose-bridge/lib/index.js");

test("bridge exports a stable contract version", () => {
  assert.equal(typeof bridge.CONTRACT, "number");
  assert.ok(Number.isInteger(bridge.CONTRACT) && bridge.CONTRACT >= 1);
});

test("capabilities are a unique, non-empty list of strings including the native protocol", () => {
  const caps = bridge.CAPABILITIES;
  assert.ok(Array.isArray(caps) && caps.length > 0);
  assert.ok(caps.every((c) => typeof c === "string" && c.length > 0));
  assert.equal(new Set(caps).size, caps.length, "capabilities must be unique");
  assert.ok(caps.includes("native-protocol-v1"));
});

test("apply is exported as a function", () => {
  assert.equal(typeof bridge.apply, "function");
});

test("negotiate intersects app capabilities with the bridge's", () => {
  assert.deepEqual(bridge.negotiate(["media-works", "nope", 5]), ["media-works"]);
  assert.deepEqual(bridge.negotiate(undefined), []);
  assert.equal(bridge.negotiate([...bridge.CAPABILITIES]).length, bridge.CAPABILITIES.length);
});
