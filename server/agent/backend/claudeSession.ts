// Per-chat-session pool of live `claude` CLI processes.
//
// Context: the CLI's `--input-format stream-json` mode is documented as
// "realtime streaming input" — one process accepts many user turns over a
// persistent stdin. We used to write one turn and immediately `stdin.end()`,
// which made the CLI re-initialise its whole MCP fleet (and replay the
// conversation via `--resume`) on *every* turn. On hosts with a normal number
// of MCP servers configured that dominated response time: 60-80 s per turn,
// uncorrelated with message length.
//
// Keeping the process alive moves that cost to the first turn of a chat.
// Measured against CLI 2.1.221: second-turn startup 4.0 s -> 0.1 s with no MCP
// servers at all, i.e. the whole MCP fleet startup is saved on turns 2+.
//
// See plans/perf-persistent-claude-session.md.

import type { ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";
import { log } from "../../system/logger/index.js";
import { CLAUDE_SESSION_IDLE_MS } from "../../utils/time.js";

export type ClaudeProc = ChildProcessByStdio<Writable, Readable, Readable>;

/** Why a session was dropped — surfaced in logs so a "why did that turn take
 *  60 s again?" question has an answer in the log rather than a guess. */
export type EvictReason = "idle" | "abort" | "crash" | "fingerprint" | "shutdown";

export interface SessionSpec {
  /** Chat session id. One live CLI process per chat. */
  readonly key: string;
  /** Hash of everything fixed at spawn time (system prompt, cli args minus
   *  --resume, workspace, docker mode). A mismatch forces a respawn. */
  readonly fingerprint: string;
  /** Builds and starts the process. Called only on a cache miss. */
  readonly spawn: () => ClaudeProc;
  /** Resources that must outlive a single turn — the MCP config file and the
   *  host-side stdio->HTTP MCP shims. Run once, on eviction. */
  readonly teardown: () => void;
}

export interface LiveSession {
  readonly proc: ClaudeProc;
  readonly stdout: LinePump;
  readonly stderr: StderrCollector;
}

interface PooledSession extends LiveSession {
  fingerprint: string;
  teardown: () => void;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<string, PooledSession>();

// ── stdout line pump ────────────────────────────────────────────
//
// `for await (const chunk of proc.stdout)` cannot be used across turns:
// breaking out of the loop calls `return()` on the async iterator, which
// destroys the underlying stream. A persistent process needs a reader that
// survives the end of a turn, so buffer lines here and let each turn drain
// what it needs.

export class LinePump {
  private buffer = "";
  private readonly queue: string[] = [];
  private notify: (() => void) | null = null;
  private ended = false;

  constructor(stream: Readable) {
    stream.on("data", (chunk: Buffer | string) => this.push(String(chunk)));
    stream.on("end", () => this.end());
    stream.on("close", () => this.end());
  }

  private push(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.queue.push(line);
    }
    this.wake();
  }

  private end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const pending = this.notify;
    this.notify = null;
    pending?.();
  }

  /** Next complete line, or null once the stream is finished and drained. */
  async next(): Promise<string | null> {
    for (;;) {
      const line = this.queue.shift();
      if (line !== undefined) return line;
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}

// ── stderr ──────────────────────────────────────────────────────
//
// Reset per turn: with a persistent process, stderr from turn 1 must not be
// reported as the cause of a failure in turn 5.

export class StderrCollector {
  private turnText = "";
  private partial = "";

  constructor(
    stream: Readable,
    private readonly onLine: (line: string) => void,
  ) {
    stream.on("data", (chunk: Buffer | string) => this.push(String(chunk)));
  }

  private push(text: string): void {
    this.turnText += text;
    this.partial += text;
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.onLine(line);
    }
  }

  reset(): void {
    this.turnText = "";
  }

  text(): string {
    return this.turnText;
  }

  /** Flush a trailing partial line at the end of a turn. */
  flush(): void {
    if (this.partial.trim()) this.onLine(this.partial);
    this.partial = "";
  }
}

// ── pool ────────────────────────────────────────────────────────

function isAlive(proc: ClaudeProc): boolean {
  return proc.exitCode === null && proc.signalCode === null && !proc.killed;
}

// Routed through a setter so claude-code.ts owns the benign-vs-real stderr
// classification without this module importing it (and creating a cycle).
let logStderr: (line: string) => void = (line) => log.error("agent-stderr", line);

export function setStderrLogger(logger: (line: string) => void): void {
  logStderr = logger;
}

/** Reuse the live process for `key`, or start one. Returns `reused: false`
 *  when a fresh process was spawned so the caller can log the cold turn. */
export async function acquireSession(spec: SessionSpec): Promise<{ session: LiveSession; reused: boolean }> {
  const existing = pool.get(spec.key);
  if (existing) {
    const reusable = isAlive(existing.proc) && existing.fingerprint === spec.fingerprint;
    if (reusable) {
      clearIdleTimer(existing);
      existing.stderr.reset();
      return { session: existing, reused: true };
    }
    evictSession(spec.key, isAlive(existing.proc) ? "fingerprint" : "crash");
  }
  const session = await startSession(spec);
  return { session, reused: false };
}

async function startSession(spec: SessionSpec): Promise<LiveSession> {
  const proc = spec.spawn();
  await waitForSpawn(proc);
  // EPIPE guard: the process can die between spawn and a later write, and a
  // write-after-death must not become an uncaught error.
  proc.stdin.on("error", () => {});
  const pooled: PooledSession = {
    proc,
    stdout: new LinePump(proc.stdout),
    stderr: new StderrCollector(proc.stderr, (line) => logStderr(line)),
    fingerprint: spec.fingerprint,
    teardown: spec.teardown,
    idleTimer: null,
  };
  pool.set(spec.key, pooled);
  return pooled;
}

function waitForSpawn(proc: ClaudeProc): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve());
    proc.once("error", (err) => reject(err));
  });
}

/** Mark the session idle and arm the eviction timer. */
export function releaseSession(key: string): void {
  const pooled = pool.get(key);
  if (!pooled) return;
  pooled.stderr.flush();
  clearIdleTimer(pooled);
  pooled.idleTimer = setTimeout(() => evictSession(key, "idle"), CLAUDE_SESSION_IDLE_MS);
  // Never let a pooled CLI process keep the server alive on shutdown.
  pooled.idleTimer.unref?.();
}

function clearIdleTimer(pooled: PooledSession): void {
  if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
  pooled.idleTimer = null;
}

export function evictSession(key: string, reason: EvictReason): void {
  const pooled = pool.get(key);
  if (!pooled) return;
  pool.delete(key);
  clearIdleTimer(pooled);
  if (isAlive(pooled.proc)) pooled.proc.kill();
  try {
    pooled.teardown();
  } catch {
    // Teardown is best-effort; a failing hook must not mask the eviction.
  }
  log.info("agent", "claude session evicted", { reason });
}

export function evictAllSessions(): void {
  for (const key of [...pool.keys()]) evictSession(key, "shutdown");
}

/** Test seam — number of live pooled sessions. */
export function pooledSessionCount(): number {
  return pool.size;
}
