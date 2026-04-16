import test from "node:test";
import assert from "node:assert/strict";

import { PolicyEngine } from "../src/policies/policy-engine.js";

test("safe-chat blocks shell commands", () => {
  const engine = new PolicyEngine();

  assert.throws(() => {
    engine.assertAllowed({
      persona: "daily-assistant",
      policy: "safe-chat",
      text: "/shell ls -la"
    });
  });
});

test("guarded-dev blocks destructive command patterns", () => {
  const engine = new PolicyEngine();

  assert.throws(() => {
    engine.assertAllowed({
      persona: "dev-control",
      policy: "guarded-dev",
      text: "Please run rm -rf /tmp/foo"
    });
  });
});
