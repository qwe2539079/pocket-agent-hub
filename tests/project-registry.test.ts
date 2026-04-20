import test from "node:test";
import assert from "node:assert/strict";

import { ProjectRegistry } from "../src/core/project.js";

test("ProjectRegistry resolves projects by id and alias", () => {
  const registry = new ProjectRegistry([
    {
      id: "pocket-agent-hub",
      path: "/tmp/pocket-agent-hub",
      description: "hub",
      defaultAgent: "codex",
      aliases: ["hub", "pah"],
    },
    {
      id: "soms",
      path: "/tmp/soms",
      description: "scenic",
      defaultAgent: "codex",
      aliases: ["scenic"],
    },
  ]);

  assert.equal(registry.get("pocket-agent-hub")?.id, "pocket-agent-hub");
  assert.equal(registry.get("hub")?.id, "pocket-agent-hub");
  assert.equal(registry.get("pah")?.id, "pocket-agent-hub");
  assert.equal(registry.get("scenic")?.id, "soms");
  assert.equal(registry.get("unknown"), undefined);
  assert.equal(registry.list().length, 2);
});

test("ProjectRegistry rejects duplicate ids", () => {
  assert.throws(
    () =>
      new ProjectRegistry([
        { id: "a", path: "/a", description: "", defaultAgent: "codex" },
        { id: "a", path: "/b", description: "", defaultAgent: "claude" },
      ]),
    /Duplicate project id: a/,
  );
});

test("ProjectRegistry rejects alias that collides with another project's id", () => {
  assert.throws(
    () =>
      new ProjectRegistry([
        { id: "hub", path: "/a", description: "", defaultAgent: "codex" },
        {
          id: "pocket-agent-hub",
          path: "/b",
          description: "",
          defaultAgent: "codex",
          aliases: ["hub"],
        },
      ]),
    /collides with project id "hub"/,
  );
});

test("ProjectRegistry rejects alias shared across two projects", () => {
  assert.throws(
    () =>
      new ProjectRegistry([
        {
          id: "a",
          path: "/a",
          description: "",
          defaultAgent: "codex",
          aliases: ["shared"],
        },
        {
          id: "b",
          path: "/b",
          description: "",
          defaultAgent: "codex",
          aliases: ["shared"],
        },
      ]),
    /used by both "a" and "b"/,
  );
});

test("ProjectRegistry lets a project declare its own id as an alias without erroring", () => {
  const registry = new ProjectRegistry([
    {
      id: "hub",
      path: "/hub",
      description: "",
      defaultAgent: "codex",
      aliases: ["hub"],
    },
  ]);
  assert.equal(registry.get("hub")?.id, "hub");
});
