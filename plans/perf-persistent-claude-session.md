# Persistent Claude CLI session per chat (kill the per-turn respawn)

## Problem

Every user turn spawns a fresh `claude` process and kills it when the turn ends.
`server/agent/backend/claude-code.ts:295-302`:

```js
// stream-json input mode: stream the user turn as a single JSON
// line to stdin, then close the pipe so the CLI knows no further
// turns are coming.
proc.stdin.write(messageLine);
proc.stdin.end();          // <- ends the session after one turn
```

The CLI therefore re-initialises its **entire MCP fleet on every turn**, plus
replays the conversation via `--resume`. On a host with a normal number of MCP
servers configured this dominates the response time.

Measured on the reporter's Windows host (15 MCP servers incl. claude.ai
connectors and plugin MCPs):

| turn | message | duration |
| --- | --- | --- |
| 1 | 5 chars | 62.7 s |
| 2 | 7 chars | 84.0 s |

`claude mcp list` (connect-only health check) took 84.2 s on the same host, i.e.
the cost is MCP startup, not inference. Response time is uncorrelated with
message length.

## The CLI already supports what we need

`--input-format stream-json` is documented in `claude --help` as
**"(realtime streaming input)"**. Verified empirically against CLI 2.1.221 by
writing two user-turn JSON lines to one stdin without calling `end()`:

```
[0.0s]  --> "Reply with exactly: ALPHA"
[4.0s]  init: session=e13d8e4b-... mcp_servers=0     <- startup 4.0 s
[14.3s] RESULT #1: success  alive=true
[14.8s] --> "Reply with exactly: BRAVO"
[14.9s] init: session=e13d8e4b-... (same session_id) <- 0.1 s, no re-init
[23.1s] RESULT #2: success  alive=true
[23.6s] EXIT (only because the test called stdin.end())
```

Turn-2 startup: **4.0 s -> 0.1 s**. With the reporter's MCP fleet the saving is
the whole ~60-80 s.

Note this also removes the per-turn `--resume` history replay, which grows with
conversation length.

## Why not `channels`

[Channels](https://code.claude.com/docs/en/channels) also imply a long-lived
session, but they are the wrong transport for the main chat loop:

- Replies leave through the channel's `reply` tool, not the output stream — the
  docs state "you see the inbound message in your terminal but not the reply
  text". We would have to rebuild `--include-partial-messages` token streaming
  and every `tool_use` / `tool_result` event out of tool calls.
- One session carries one system prompt. We rewrite `--system-prompt-file` per
  role, and the prompt varies with `activePlugins`.
- Channels push into *the* open session; we multiplex many `chatSessionId`s.
- Permission flow collides with `--permission-prompt-tool
  mcp__mulmoclaude__handlePermission`.
- Research preview: allowlist-gated, flag absent from `--help`, "protocol
  contract may change".

Channels remain interesting as a **later addition** (push CI/Telegram events
into a MulmoClaude session), not as a replacement for stdin.

## Design

Add a per-chat-session process pool. Key: `chatSessionId` (`input.sessionId`).

```
server/agent/backend/claudeSession.ts   (new)
  acquire(key, spec) -> LiveSession       reuse or spawn
  release(key)                            mark idle, start idle timer
  evict(key, reason)                      kill proc + run teardown hooks
  evictAll()                              server shutdown
```

`LiveSession` holds: the `ClaudeProc`, a **fingerprint**, `busy`, `lastUsedAt`,
and the teardown hooks for resources that must outlive a turn (below).

### Turn boundary moves from process exit to the `result` event

Today `readAgentEvents` ends when stdout closes. With a persistent process the
generator must return on the stream-json `result` event, which the parser
already recognises (`server/agent/stream.ts:142`). Process `close` stops being
the normal terminator and becomes the crash path.

### Fingerprint — when we must respawn anyway

The system prompt and `--allowedTools` are fixed at spawn. Respawn when any of
these change:

- `systemPrompt` (covers role switch, plugin toggle, memory snapshot changes)
- resolved `cliArgs` minus `--resume`
- `workspacePath`, `useDocker`

Hash them into a fingerprint; a mismatch evicts and respawns. Correctness first:
a stale prompt is worse than a slow turn.

### Resources whose lifetime must follow the process

Two per-turn teardowns in `server/agent/index.ts` break a persistent process and
must move to session eviction:

- `index.ts:63` — `unlink(prepared.hostMcpPath)` deletes the MCP config file
  after each turn.
- `index.ts:70-77` — `shim.close()` tears down host-side stdio->HTTP MCP
  gateways (`prepareUserServers`), which are real processes holding ports the
  live CLI is connected to.

Both become teardown hooks on `LiveSession`, run on eviction.

### Abort

`input.abortSignal` currently does `proc.kill()`. Keep killing, but also evict
the session so the next turn respawns with `--resume <sessionToken>`. Simpler
and safer than implementing a mid-turn interrupt; the cost (one cold turn after
pressing stop) is acceptable for v1.

### Crash recovery

A dead process is detected on acquire (`exitCode !== null`) or on an stdin
EPIPE. Evict and respawn with `--resume <sessionToken>` — the CLI session id
already flows back through the stream (`stream.ts:147-150`) and is stored as
`sessionToken`.

### Idle eviction

Timer per session (default 10 min, constant in `server/utils/time.ts`). N open
chats hold N live CLI processes; without eviction that leaks memory.

## Scope

**In**: native (non-Docker) spawn path — where the reported problem is.

**Out**: Docker mode keeps the current per-turn `docker run`. A persistent
container per chat is a heavier change with its own teardown semantics, and the
reporting host has no Docker. `useDocker` is part of the fingerprint, so the two
paths cannot mix.

## Steps

1. `server/agent/backend/claudeSession.ts` — pool, fingerprint, idle eviction,
   teardown hooks.
2. `claude-code.ts` — acquire instead of spawn; do not call `stdin.end()`; end
   the turn on `result`; treat process `close` as the crash path.
3. `index.ts` — move MCP config unlink + shim teardown into session hooks.
4. Server shutdown — `evictAll()`.
5. Tests under `test/agent/`: reuse across turns, fingerprint-change respawn,
   crash respawn, abort eviction, idle eviction, teardown-hook ordering.
6. `packages/core/assets/helps/error-recovery.md` — MCP-startup-dominated
   slowness and how to confirm it with `claude mcp list`.

## Verification

- `yarn format` / `yarn lint` (0 errors) / `yarn typecheck` / `yarn build` all
  clean.
- 17 new unit tests (`test/agent/test_claudeSession.ts`,
  `test/agent/test_sessionFingerprint.ts`) green.
- Full suite: 9023/9094 pass. The 25 failures are pre-existing environment
  limits on this Windows host — 23 `EPERM: symlink` (needs Developer Mode /
  admin), 1 assertion downstream of a failed symlink setup, and 2
  `test_mcp_smoke` timeouts under full-suite contention that pass 4/4 when the
  file runs alone. Confirmed against a stashed baseline.

### Measured end-to-end

Three consecutive turns in one chat, driven through `POST /api/agent` on the
reporting host (15 MCP servers configured):

| turn | `durationMs` | `reused` |
| --- | --- | --- |
| 1 (cold) | 67,114 | false |
| 2 (warm) | 19,278 | true |
| 3 (warm) | 20,385 | true |

Follow-up turns dropped **67 s -> ~20 s (-71%)**. The residual ~20 s is model
inference; MCP startup is gone from turns 2+. For comparison, before the change
the same host measured 62.7 s and 84.0 s for 5- and 7-character messages.

Idle eviction and the crash / fingerprint respawn paths are covered by unit
tests rather than the live run.

## Known inefficiency (deliberate, not a regression)

`prepareUserServers` still runs every turn, so a chat with opted-in stdio->HTTP
MCP shims spawns a fresh set on a warm turn and immediately tears them down
unused (the live process stays wired to the originals). Correct, but wasteful.
Hoisting shim creation behind the same session key is the natural follow-up;
it is a no-op for the common case of zero opted-in servers.
