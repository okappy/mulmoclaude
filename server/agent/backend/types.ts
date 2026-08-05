// LLM backend abstraction. Today the only implementation is
// ClaudeCodeBackend (server/agent/backend/claude-code.ts), which spawns
// the `claude` CLI as a subprocess. The interface exists so future
// backends (OpenAI, Ollama native, Gemini, etc.) can plug in here
// without the orchestrator in server/agent/index.ts knowing which one
// is active.
//
// See plans/done/refactor-llm-backend-abstraction.md for the broader plan.

import type { Attachment } from "@mulmobridge/protocol";
import type { Role } from "../../../src/config/roles.js";
import type { EffortLevel } from "../../system/config.js";
import type { AgentEvent } from "../stream.js";

/** Inputs the orchestrator passes to a backend for one user turn.
 *  The orchestrator owns role expansion, system prompt building, and
 *  MCP config writing. The backend owns the LLM call itself plus
 *  translation of provider-specific stream events into AgentEvent. */
export interface AgentInput {
  systemPrompt: string;
  message: string;
  role: Role;
  workspacePath: string;
  sessionId: string;
  port: number;
  /** Opaque, backend-specific resume token. For Claude this is the
   *  CLI's session id passed to --resume; other backends may
   *  interpret it differently or ignore it entirely
   *  (capabilities.sessionResume === false). */
  sessionToken?: string | undefined;
  attachments?: Attachment[] | undefined;
  /** Active MCP plugin names (the subset of role.availablePlugins
   *  that is actually registered as an MCP plugin). The orchestrator
   *  has already filtered these — backends should not re-derive. */
  activePlugins: string[];
  /** When set, the path the backend should hand to its MCP loader.
   *  Pre-resolved for host-vs-container by the orchestrator. */
  mcpConfigPath?: string | undefined;
  /** Extra allowed-tool names from settings + user MCP servers. */
  extraAllowedTools: string[];
  /** Reasoning effort from settings (#1323). Undefined → flag omitted. */
  effortLevel?: EffortLevel | undefined;
  /** When fired, the backend must terminate any in-flight
   *  subprocess / connection. */
  abortSignal?: AbortSignal | undefined;
  userTimezone?: string | undefined;
  /** Whether the orchestrator detected a usable Docker sandbox.
   *  Backends that don't sandbox can ignore. */
  useDocker: boolean;
  /** Per-turn MCP resources (config file + host-side stdio->HTTP shims)
   *  that a backend keeping a live process past the turn must adopt.
   *  Absent for backends the orchestrator runs without MCP. */
  turnResources?: TurnResources | undefined;
}

/** Ownership handoff for resources the orchestrator creates per turn but a
 *  persistent backend needs for the lifetime of its process.
 *
 *  The orchestrator tears these down after the turn UNLESS the backend sets
 *  `retained`, which means the backend adopted THIS turn's resources and will
 *  call `teardown` itself when its process dies. A backend that reused an
 *  already-live process must leave `retained` false: the resources built for
 *  this turn went unused and the orchestrator should drop them. */
export interface TurnResources {
  /** Release the MCP config file and any host-side MCP shims. Idempotent. */
  readonly teardown: () => void;
  /** Set by the backend when it takes ownership. */
  retained: boolean;
}

export interface BackendCapabilities {
  /** Can the backend resume a prior conversation by an opaque token?
   *  Claude: yes (--resume <id>). OpenAI / Ollama: no — the
   *  orchestrator must replay transcript instead. */
  sessionResume: boolean;
  /** Does the backend speak MCP natively? Claude: yes. Others:
   *  emulate or skip. Today only Claude consumes activePlugins /
   *  mcpConfigPath. */
  mcp: boolean;
}

export interface LLMBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  /** Run one user turn. Yields portable AgentEvents. */
  runAgent: (input: AgentInput) => AsyncIterable<AgentEvent>;
}
