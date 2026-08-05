// Backend factory. Today there is only ClaudeCodeBackend; future
// backends (OpenAI, Ollama native, Gemini) are selected here based on
// env / settings. Callers go through getActiveBackend() rather than
// importing a concrete adapter so adding a backend doesn't require
// touching every call site.
//
// Tests / CI swap in `fakeEchoBackend` via setActiveBackend() at
// server bootstrap; the decision is made once and read with zero
// per-call overhead by the agent orchestrator.

import { claudeCodeBackend } from "./claude-code.js";
import type { LLMBackend } from "./types.js";

export type { AgentInput, BackendCapabilities, LLMBackend, TurnResources } from "./types.js";

let activeBackend: LLMBackend = claudeCodeBackend;

/** Replace the active backend. Intended for server-bootstrap wiring
 *  (e.g. CI sets `MULMOCLAUDE_FAKE_AGENT=1`, the boot script then
 *  passes `fakeEchoBackend` here). Not safe to call mid-flight — the
 *  in-flight agent generators have already captured the previous
 *  backend reference, and swapping under them would race. */
export function setActiveBackend(backend: LLMBackend): void {
  activeBackend = backend;
}

export function getActiveBackend(): LLMBackend {
  return activeBackend;
}
