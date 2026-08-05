import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  LinePump,
  StderrCollector,
  acquireSession,
  evictAllSessions,
  evictSession,
  pooledSessionCount,
  type ClaudeProc,
} from "../../server/agent/backend/claudeSession.js";

// Coverage for the persistent-session pool (plans/perf-persistent-claude-session.md).
// The pool is what stops every user turn from re-initialising the CLI's whole
// MCP fleet, so the reuse / respawn decision is the load-bearing behaviour here.

interface FakeProc {
  proc: ClaudeProc;
  stdout: PassThrough;
  stderr: PassThrough;
  writes: string[];
  kill: () => void;
}

function fakeProc(): FakeProc {
  const emitter = new EventEmitter() as unknown as ClaudeProc & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const proc = emitter as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: (s: string) => void; on: () => void };
    exitCode: number | null;
    signalCode: string | null;
    killed: boolean;
    kill: () => void;
  } & EventEmitter;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = {
    write: (text: string) => {
      writes.push(text);
    },
    on: () => {},
  };
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.exitCode = 143;
  };
  // The pool awaits the kernel's `spawn` confirmation before using the process.
  setImmediate(() => proc.emit("spawn"));
  return {
    proc: proc as unknown as ClaudeProc,
    stdout,
    stderr,
    writes,
    kill: () => proc.kill(),
  };
}

beforeEach(() => evictAllSessions());

test("second turn reuses the live process instead of respawning", async () => {
  const first = fakeProc();
  let spawns = 0;
  const spec = {
    key: "chat-1",
    fingerprint: "fp-a",
    spawn: () => {
      spawns++;
      return first.proc;
    },
    teardown: () => {},
  };

  const turn1 = await acquireSession(spec);
  assert.equal(turn1.reused, false);
  const turn2 = await acquireSession(spec);
  assert.equal(turn2.reused, true);
  assert.equal(spawns, 1, "a reused turn must not spawn a second CLI process");
  assert.equal(turn2.session.proc, turn1.session.proc);
});

test("fingerprint change respawns and tears down the old session's resources", async () => {
  const first = fakeProc();
  const second = fakeProc();
  const procs = [first.proc, second.proc];
  let teardowns = 0;
  const base = {
    key: "chat-1",
    spawn: () => procs.shift() as ClaudeProc,
    teardown: () => {
      teardowns++;
    },
  };

  const turn1 = await acquireSession({ ...base, fingerprint: "fp-a" });
  // A different system prompt (role switch, plugin toggle) cannot be applied to
  // a live process — a stale prompt is worse than one cold turn.
  const turn2 = await acquireSession({ ...base, fingerprint: "fp-b" });

  assert.equal(turn2.reused, false);
  assert.notEqual(turn2.session.proc, turn1.session.proc);
  assert.equal(teardowns, 1, "the replaced session's MCP resources must be released");
  assert.equal(first.proc.killed, true);
});

test("a dead process is not reused — the next turn respawns", async () => {
  const first = fakeProc();
  const second = fakeProc();
  const procs = [first.proc, second.proc];
  const spec = {
    key: "chat-1",
    fingerprint: "fp-a",
    spawn: () => procs.shift() as ClaudeProc,
    teardown: () => {},
  };

  await acquireSession(spec);
  first.kill(); // CLI crashed between turns
  const turn2 = await acquireSession(spec);

  assert.equal(turn2.reused, false);
  assert.equal(turn2.session.proc, second.proc);
});

test("evictSession runs teardown exactly once and drops the session", async () => {
  let teardowns = 0;
  await acquireSession({
    key: "chat-1",
    fingerprint: "fp-a",
    spawn: () => fakeProc().proc,
    teardown: () => {
      teardowns++;
    },
  });
  assert.equal(pooledSessionCount(), 1);

  evictSession("chat-1", "abort");
  evictSession("chat-1", "abort"); // idempotent — a crash after an abort must not double-free

  assert.equal(teardowns, 1);
  assert.equal(pooledSessionCount(), 0);
});

test("a failing teardown hook does not block eviction", async () => {
  await acquireSession({
    key: "chat-1",
    fingerprint: "fp-a",
    spawn: () => fakeProc().proc,
    teardown: () => {
      throw new Error("shim close blew up");
    },
  });
  assert.doesNotThrow(() => evictSession("chat-1", "shutdown"));
  assert.equal(pooledSessionCount(), 0);
});

test("evictAllSessions clears every pooled chat (server shutdown)", async () => {
  for (const key of ["chat-1", "chat-2", "chat-3"]) {
    await acquireSession({ key, fingerprint: "fp", spawn: () => fakeProc().proc, teardown: () => {} });
  }
  assert.equal(pooledSessionCount(), 3);
  evictAllSessions();
  assert.equal(pooledSessionCount(), 0);
});

test("LinePump holds a partial line until its newline arrives", async () => {
  const stream = new PassThrough();
  const pump = new LinePump(stream);

  stream.write('{"type":"a"}\n{"ty');
  assert.equal(await pump.next(), '{"type":"a"}');

  stream.write('pe":"b"}\n');
  assert.equal(await pump.next(), '{"type":"b"}');

  stream.end();
  assert.equal(await pump.next(), null, "a finished stream reports end, not a hang");
});

test("LinePump skips blank lines and survives the turn boundary", async () => {
  const stream = new PassThrough();
  const pump = new LinePump(stream);
  stream.write("one\n\n   \ntwo\n");
  assert.equal(await pump.next(), "one");
  // The whole point of the pump: reading stops at a turn boundary and the
  // remaining buffer is still there for the next turn.
  assert.equal(await pump.next(), "two");
});

test("StderrCollector.reset scopes stderr to the current turn", () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  const collector = new StderrCollector(stream, (line) => lines.push(line));

  stream.write("turn one boom\n");
  assert.match(collector.text(), /turn one boom/);

  collector.reset();
  // Without the reset, turn 1's stderr would be reported as the cause of a
  // failure in turn 5.
  assert.equal(collector.text(), "");
  stream.write("turn two boom\n");
  assert.match(collector.text(), /turn two boom/);
  assert.doesNotMatch(collector.text(), /turn one/);
  assert.deepEqual(lines, ["turn one boom", "turn two boom"]);
});

test("StderrCollector.flush emits a trailing line with no newline", () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  const collector = new StderrCollector(stream, (line) => lines.push(line));
  stream.write("no trailing newline");
  assert.deepEqual(lines, []);
  collector.flush();
  assert.deepEqual(lines, ["no trailing newline"]);
});
