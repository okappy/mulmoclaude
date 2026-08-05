// Claude Code backend: spawns the `claude` CLI as a subprocess (or
// inside the mulmoclaude-sandbox Docker image) and translates its
// stream-json output into portable AgentEvents.
//
// This file is the single seam between the orchestrator in
// server/agent/index.ts (which is backend-agnostic) and the Claude
// CLI specifics. Pure helpers it depends on (CLI arg construction,
// Docker arg construction, stream parsing) stay in their existing
// home so the existing test suite under test/agent/ keeps working
// unchanged.

import { spawn } from "child_process";
import { createHash } from "node:crypto";
import { buildCliArgs, buildDockerSpawnArgs, buildUserMessageLine, resolveSystemPromptPaths, type CliArgsParams } from "../config.js";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { resolveSandboxAuth } from "../sandboxMounts.js";
import { getCachedReferenceDirs, referenceDirMountArgs } from "../../workspace/reference-dirs.js";
import { createStreamParser, type AgentEvent, type RawStreamEvent } from "../stream.js";
import { createMcpFailureMonitor } from "../mcpFailureMonitor.js";
import { isMcpBrokerNotReadyError } from "../mcpBrokerFailover.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { EVENT_TYPES } from "../../../src/types/events.js";
import { env } from "../../system/env.js";
import { claudeBinPath } from "../../utils/claudeBin.js";
import {
  LinePump,
  StderrCollector,
  acquireSession,
  evictSession,
  releaseSession,
  setStderrLogger,
  type ClaudeProc,
  type LiveSession,
} from "./claudeSession.js";
import type { AgentInput, LLMBackend } from "./types.js";

function spawnClaude(useDocker: boolean, workspacePath: string, cliArgs: string[], chatSessionId: string): ClaudeProc {
  if (!useDocker) {
    // MULMOCLAUDE_CHAT_SESSION_ID is the chat-session id our wiki-history
    // PostToolUse hook needs to publish a `page-edit` toolResult back to
    // the right session (#963). Claude CLI's own hook payload carries
    // its internal session_id, which doesn't match our session store.
    return spawn(claudeBinPath(), cliArgs, {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MULMOCLAUDE_CHAT_SESSION_ID: chatSessionId },
    });
  }
  const sandboxAuth = resolveSandboxAuth({
    sshAgentForward: env.sandboxSshAgentForward,
    sshAllowedHosts: env.sandboxSshAllowedHosts,
    configMountNames: env.sandboxMountConfigs,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
  });
  const refDirArgs = referenceDirMountArgs(getCachedReferenceDirs());
  const dockerArgs = buildDockerSpawnArgs({
    workspacePath,
    cliArgs,
    chatSessionId,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    platform: process.platform,
    sandboxAuthArgs: [...sandboxAuth.args, ...refDirArgs],
    sshAgentForward: env.sandboxSshAgentForward,
  });
  return spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
}

// Track MCP tool usage to detect silent MCP server failures.
// If ToolSearch was called but no mcp__* tool was ever invoked,
// the MCP server likely crashed on startup (e.g. module resolution
// failure inside Docker). See #430.
function createMcpTracker() {
  let toolSearchCalled = false;
  let mcpToolCalled = false;
  return {
    track(event: AgentEvent) {
      if (event.type !== EVENT_TYPES.toolCall) return;
      if (event.toolName === "ToolSearch") toolSearchCalled = true;
      if (event.toolName.startsWith("mcp__")) mcpToolCalled = true;
    },
    logIfSuspicious() {
      if (toolSearchCalled && !mcpToolCalled) {
        log.warn(
          "agent",
          "ToolSearch was used but no MCP tool was called — the MCP server may have crashed. " +
            "Check Docker volume mounts and package.json exports. " +
            "Run: npx tsx --test test/agent/test_mcp_docker_smoke.ts",
        );
      }
    },
  };
}

// Exit codes the claude CLI reports when it is terminated by one of the
// signals our abort handler sends: 128 + signal number (SIGTERM=15 → 143,
// SIGKILL=9 → 137). Node also reports a null code with `signal` set when a
// signal kills the process directly without the CLI's own handler running.
const ABORT_EXIT_CODES = new Set([143, 137]);
const ABORT_SIGNALS = new Set<string>(["SIGTERM", "SIGKILL"]);

// A non-zero exit caused by our own abort (stop button → proc.kill()) is
// expected, not a failure — surfacing it as an error event makes a deliberate
// stop look like a crash. Suppress it ONLY when we actually aborted AND the
// exit is signal-shaped, so a genuine crash that happens to coincide with a
// stop click still surfaces its real error.
export function isAbortCausedExit(exitCode: number | null, signal: string | null, abortSignal?: AbortSignal): boolean {
  if (!abortSignal?.aborted) return false;
  if (signal !== null && ABORT_SIGNALS.has(signal)) return true;
  return exitCode !== null && ABORT_EXIT_CODES.has(exitCode);
}

// Build the error event for a finished claude process, or null when nothing
// should surface (clean exit, or a deliberate abort). exitCode is null when a
// signal — not a code — ended the process, so name the signal in that case
// rather than emitting "claude exited with code null".
export function buildExitErrorEvent(
  exitCode: number | null,
  signal: string | null,
  abortSignal: AbortSignal | undefined,
  stderrOutput: string,
): { type: typeof EVENT_TYPES.error; message: string } | null {
  if (exitCode === 0 || isAbortCausedExit(exitCode, signal, abortSignal)) return null;
  const exitSummary = exitCode !== null ? `claude exited with code ${exitCode}` : `claude terminated by signal ${signal ?? "unknown"}`;
  return { type: EVENT_TYPES.error, message: stderrOutput || exitSummary };
}

// The broker startup race (#2057) can leave the CLI exiting 0 — the model gives
// up after the first tool call fails, so `buildExitErrorEvent` sees a clean exit
// and returns null. Scan stderr for the permission-prompt-tool phrase and
// surface it as an error the fail-over loop can retry on. A non-zero exit
// carrying the same phrase already flows through `buildExitErrorEvent`, so this
// only covers the clean-exit case.
export function brokerNotReadyErrorEvent(stderrOutput: string): { type: typeof EVENT_TYPES.error; message: string } | null {
  return isMcpBrokerNotReadyError(stderrOutput) ? { type: EVENT_TYPES.error, message: stderrOutput } : null;
}

// Not every claude CLI stderr line is an error. The sandbox workspace-trust
// notice (#2055) is the common benign case: the container's workspace path
// (`/home/node/mulmoclaude`) isn't among the host `~/.claude.json`'s trusted
// projects, so claude ignores the workspace `permissions.allow` entries. That's
// harmless here — tool permissions come from `--allowedTools` + the mulmoclaude
// MCP permission handler, not the workspace `.claude/settings.json` — but
// logging it at ERROR on every spawn made it look like a failure and buried
// real errors. Recognise it so the stderr router can log it at debug instead.
export function isBenignClaudeStderr(line: string): boolean {
  return line.includes("has not been trusted");
}

// Route a claude CLI stderr line to the right log level: benign notices at
// debug, genuine errors at error (so they stop burying each other).
function logAgentStderr(line: string): void {
  if (isBenignClaudeStderr(line)) log.debug("agent-stderr", line);
  else log.error("agent-stderr", line);
}

// Classification lives here (isBenignClaudeStderr), the pool owns the
// streams — hand the router over rather than have the pool import this file.
setStderrLogger(logAgentStderr);

/** Resolve once the process is really gone. Returns immediately when it
 *  already exited, so the crash path never hangs on a `close` that fired
 *  before we started listening. */
function awaitClose(proc: ClaudeProc): Promise<{ code: number | null; signal: string | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  }
  return new Promise((resolve) => proc.once("close", (code, sig) => resolve({ code, signal: sig })));
}

/** Drain one user turn's worth of events.
 *
 *  A turn ends at the stream-json `result` event, NOT at process exit — the
 *  process outlives the turn so the next one skips MCP startup. Running out of
 *  stdout instead means the CLI died mid-turn, which is the crash path.
 *
 *  Returns true when the turn completed normally (process still usable). */
async function* readTurnEvents(session: LiveSession, abortSignal: AbortSignal | undefined, outcome: { completed: boolean }): AsyncGenerator<AgentEvent> {
  // Stateful parser tracks whether text was already streamed via
  // assistant content blocks so the final `result` event's duplicate
  // text is suppressed. See createStreamParser() in stream.ts.
  const parser = createStreamParser();
  const mcpTracker = createMcpTracker();
  // Runtime failure monitor (#1353). Lives next to mcpTracker
  // because they share the same event stream — the tracker spots
  // the "MCP never invoked" pattern, the monitor spots the
  // "MCP invoked but consistently failing" pattern.
  const mcpFailureMonitor = createMcpFailureMonitor();

  for (;;) {
    const line = await session.stdout.next();
    if (line === null) break;
    let event: RawStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const agentEvent of parser.parse(event)) {
      mcpTracker.track(agentEvent);
      mcpFailureMonitor.track(agentEvent);
      yield agentEvent;
    }
    if (event.type === "result") {
      outcome.completed = true;
      mcpTracker.logIfSuspicious();
      return;
    }
  }

  // stdout ended without a `result` — the CLI died mid-turn.
  const { code: exitCode, signal } = await awaitClose(session.proc);
  session.stderr.flush();
  log.info("agent", "claude exited", { exitCode, signal });
  mcpTracker.logIfSuspicious();

  const stderrOutput = session.stderr.text();
  const errorEvent = buildExitErrorEvent(exitCode, signal, abortSignal, stderrOutput) ?? brokerNotReadyErrorEvent(stderrOutput);
  if (errorEvent) yield errorEvent;
}

// The non-pass-through mappings are `sessionToken` -> `claudeSessionId`
// (the CLI's `--resume` id) and the system prompt, which travels as a
// file path (`systemPromptPath`) rather than inline text — see the
// CliArgsParams field comment for the Windows ENAMETOOLONG rationale.
export function cliArgsForInput(input: AgentInput, systemPromptPath: string): CliArgsParams {
  return {
    systemPromptPath,
    activePlugins: input.activePlugins,
    claudeSessionId: input.sessionToken,
    mcpConfigPath: input.mcpConfigPath,
    extraAllowedTools: input.extraAllowedTools,
    effortLevel: input.effortLevel,
  };
}

// Write the per-session system-prompt file the CLI reads via
// `--system-prompt-file`, returning the path to put on the command line
// (container path under Docker). Atomic so a concurrent spawn on the
// same session never reads a half-written prompt; one file per session,
// overwritten each turn (mirroring the MCP config lifecycle). Mode 0600
// because the prompt carries the role / memory / plugin instructions —
// no reason for it to be world-readable in the OS tmpdir or workspace.
export async function writeSystemPromptFile(input: AgentInput): Promise<string> {
  const paths = resolveSystemPromptPaths({
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    useDocker: input.useDocker,
  });
  await writeFileAtomic(paths.hostPath, input.systemPrompt, { mode: 0o600 });
  return paths.argPath;
}

// Everything the CLI fixes at spawn time. A change here cannot be applied to a
// live process, so it must force a respawn: a stale system prompt (wrong role,
// wrong plugin set, stale memory snapshot) is worse than one cold turn.
export function sessionFingerprint(input: AgentInput, cliArgs: string[]): string {
  // --resume carries the CLI session id, which legitimately changes between
  // the first and second turn of a chat. Excluding it is what lets turn 2
  // reuse turn 1's process.
  const stable: string[] = [];
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === "--resume") {
      i++;
      continue;
    }
    stable.push(cliArgs[i] ?? "");
  }
  const material = JSON.stringify([input.systemPrompt, stable, input.workspacePath, input.useDocker]);
  return createHash("sha256").update(material).digest("hex");
}

function spawnFailureEvent(useDocker: boolean, err: unknown, phase: "resolve" | "spawn"): AgentEvent {
  const target = useDocker ? "docker" : "claude";
  const message = errorMessage(err);
  log.error("agent", `failed to ${phase} ${target}${phase === "resolve" ? " binary" : ""}`, { error: message });
  return { type: EVENT_TYPES.error, message: `Failed to spawn ${target}: ${message}` };
}

// Docker keeps the original one-process-per-turn shape: a persistent container
// per chat has its own teardown semantics and is out of scope here (see
// plans/perf-persistent-claude-session.md). `useDocker` is part of the
// fingerprint, so the two paths can never share a process.
async function* runDockerTurn(input: AgentInput, cliArgs: string[]): AsyncGenerator<AgentEvent> {
  let proc: ClaudeProc;
  try {
    proc = spawnClaude(true, input.workspacePath, cliArgs, input.sessionId);
  } catch (err) {
    yield spawnFailureEvent(true, err, "resolve");
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err) => reject(err));
    });
  } catch (err) {
    yield spawnFailureEvent(true, err, "spawn");
    return;
  }
  proc.stdin.on("error", () => {});
  const session: LiveSession = {
    proc,
    stdout: new LinePump(proc.stdout),
    stderr: new StderrCollector(proc.stderr, logAgentStderr),
  };
  proc.stdin.write(await buildUserMessageLine(input.message, input.attachments));
  proc.stdin.end();

  const onAbort = () => {
    if (!proc.killed) proc.kill();
  };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    yield* readTurnEvents(session, input.abortSignal, { completed: false });
  } finally {
    input.abortSignal?.removeEventListener("abort", onAbort);
    if (!proc.killed) proc.kill();
  }
}

async function* runClaudeAgent(input: AgentInput): AsyncGenerator<AgentEvent> {
  const systemPromptPath = await writeSystemPromptFile(input);
  const cliArgs = buildCliArgs(cliArgsForInput(input, systemPromptPath));

  if (input.useDocker) {
    yield* runDockerTurn(input, cliArgs);
    return;
  }

  const resources = input.turnResources;
  let acquired: Awaited<ReturnType<typeof acquireSession>>;
  try {
    acquired = await acquireSession({
      key: input.sessionId,
      fingerprint: sessionFingerprint(input, cliArgs),
      // Throws synchronously when `claudeBinPath()` cannot find claude.exe on
      // Windows — surfaced as an AgentEvent so the server stays alive (#1364)
      // and the user sees the "install with npm install -g …" hint.
      spawn: () => spawnClaude(false, input.workspacePath, cliArgs, input.sessionId),
      teardown: () => resources?.teardown(),
    });
  } catch (err) {
    yield spawnFailureEvent(false, err, "spawn");
    return;
  }
  // A fresh process adopts THIS turn's MCP config + shims for its whole life.
  // A reused one already owns an equivalent set, so the orchestrator drops the
  // ones it just built (they were never wired up).
  if (resources && !acquired.reused) resources.retained = true;
  log.info("agent", "claude session acquired", { reused: acquired.reused });

  const { session } = acquired;
  session.proc.stdin.write(await buildUserMessageLine(input.message, input.attachments));

  // Abort ends the whole session rather than just the turn: the CLI has no
  // mid-turn interrupt over stdin, and a half-drained stream would corrupt the
  // next turn. The next message respawns and picks the conversation back up
  // via --resume.
  const onAbort = () => evictSession(input.sessionId, "abort");
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const outcome = { completed: false };
  try {
    yield* readTurnEvents(session, input.abortSignal, outcome);
  } finally {
    input.abortSignal?.removeEventListener("abort", onAbort);
    if (outcome.completed) releaseSession(input.sessionId);
    else evictSession(input.sessionId, "crash");
  }
}

export const claudeCodeBackend: LLMBackend = {
  id: "claude-code",
  capabilities: { sessionResume: true, mcp: true },
  runAgent: runClaudeAgent,
};
