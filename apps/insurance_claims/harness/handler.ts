import type { ModelFn, RunResult, Event, Message } from "../../../agent-loop/types.ts";
import { runAgentLoop } from "../../../agent-loop/agent-loop.ts";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { buildSystemPrompt } from "../prompts/system-prompt.ts";
import { buildRuntimeContext } from "../prompts/context-builder.ts";
import { getAllowedTools } from "../tools/tool-registry.ts";
import { guard } from "./guard.ts";
import { persist } from "./persist.ts";

// ── Outer handler ─────────────────────────────────────────────────────────────

export interface HandleMessageOptions {
  sessionId: string;
  userMessage: string;
  model: ModelFn;
  priorMessages?: Message[];
  emit?: (event: Event) => void | Promise<void>;
  nowIso?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  signal?: AbortSignal;
}

export async function handleMessage(opts: HandleMessageOptions): Promise<RunResult> {
  const {
    sessionId, userMessage, model,
    priorMessages = [],
    emit, signal, maxTurns = 8, maxToolCalls = 16,
  } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  // ── Derive state from current facts and build context ──────────────────────
  const events = getEvents(sessionId);
  const facts  = reduceSessionEvents(events);
  const state  = deriveSopState(facts);
  const runtimeContext = buildRuntimeContext(facts, state, nowIso);
  const tools  = getAllowedTools(state, sessionId, nowIso);

  // ── Run conversation loop ──────────────────────────────────────────────────
  // The LLM records identity fields by calling record_user_information.
  // The persist hook triggers identity verification automatically after
  // that tool call once enough fields have been collected.
  return runAgentLoop(userMessage, {
    systemPrompt: buildSystemPrompt(),
    runtimeContext,
    messages: [...priorMessages],
    tools,
  }, {
    model,
    signal,
    maxTurns,
    maxToolCalls,
    emit,

    prepareRequest(context) {
      const ev = getEvents(sessionId);
      const f  = reduceSessionEvents(ev);
      const s  = deriveSopState(f);
      context.runtimeContext = buildRuntimeContext(f, s, nowIso);
      context.tools          = getAllowedTools(s, sessionId, nowIso);
    },

    beforeToolCall(call, context) {
      return guard(call, context, sessionId);
    },

    afterToolCall(call, result, context) {
      return persist(call, result, context, sessionId, nowIso);
    },

    finishTurn(_context, message, results) {
      if (message.toolCalls.length === 0 && results.length === 0) return "end";
      return undefined;
    },
  });
}
