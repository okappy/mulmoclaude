import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionFingerprint } from "../../server/agent/backend/claude-code.js";
import type { AgentInput } from "../../server/agent/backend/types.js";
import type { Role } from "../../src/config/roles.js";

// The fingerprint decides whether a turn reuses the live CLI process. Getting
// it wrong is silently expensive in one direction (never reuses → every turn
// pays MCP startup again) and silently WRONG in the other (reuses a process
// running a stale system prompt). Both directions are locked here.
// See plans/perf-persistent-claude-session.md.

const ROLE = { id: "general" } as unknown as Role;

function input(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    systemPrompt: "you are a helpful agent",
    message: "hi",
    role: ROLE,
    workspacePath: "/ws",
    sessionId: "chat-1",
    port: 3001,
    activePlugins: [],
    extraAllowedTools: [],
    useDocker: false,
    ...overrides,
  };
}

const ARGS = ["--output-format", "stream-json", "--system-prompt-file", "/tmp/p.txt", "-p"];

test("the --resume id is excluded so turn 2 can reuse turn 1's process", () => {
  // Turn 1 has no session id yet; turn 2 carries the one the CLI reported
  // back. That difference must NOT force a respawn — it is the entire point.
  const cold = sessionFingerprint(input(), ARGS);
  const resumed = sessionFingerprint(input(), [...ARGS, "--resume", "abc-123"]);
  assert.equal(cold, resumed);
});

test("two different --resume ids still fingerprint the same", () => {
  const first = sessionFingerprint(input(), ["--resume", "id-a", ...ARGS]);
  const second = sessionFingerprint(input(), ["--resume", "id-b", ...ARGS]);
  assert.equal(first, second);
});

test("a changed system prompt forces a respawn", () => {
  // Role switch, plugin toggle and memory-snapshot changes all land here.
  const before = sessionFingerprint(input(), ARGS);
  const after = sessionFingerprint(input({ systemPrompt: "you are a research agent" }), ARGS);
  assert.notEqual(before, after);
});

test("changed cli args force a respawn", () => {
  const before = sessionFingerprint(input(), ARGS);
  const after = sessionFingerprint(input(), [...ARGS, "--effort", "high"]);
  assert.notEqual(before, after);
});

test("workspace and docker mode are part of the identity", () => {
  const base = sessionFingerprint(input(), ARGS);
  assert.notEqual(base, sessionFingerprint(input({ workspacePath: "/other" }), ARGS));
  // Docker turns never share a process with native ones.
  assert.notEqual(base, sessionFingerprint(input({ useDocker: true }), ARGS));
});

test("identical inputs are stable across calls", () => {
  assert.equal(sessionFingerprint(input(), ARGS), sessionFingerprint(input(), ARGS));
});

test("an --allowedTools change is not masked by argument order", () => {
  const wide = sessionFingerprint(input(), ["--allowedTools", "Read,Write", ...ARGS]);
  const narrow = sessionFingerprint(input(), ["--allowedTools", "Read", ...ARGS]);
  assert.notEqual(wide, narrow);
});
