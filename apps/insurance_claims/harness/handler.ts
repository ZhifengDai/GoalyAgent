import type { ModelFn, RunResult, Event, Message } from "../../../agent-loop/types.ts";
import { runAgentLoop } from "../../../agent-loop/agent-loop.ts";
import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import type { FieldObservation, CaseHintObservation } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { buildSystemPrompt } from "../prompts/system-prompt.ts";
import { buildExtractionPrompt } from "../prompts/extraction-prompt.ts";
import { buildRuntimeContext } from "../prompts/context-builder.ts";
import { getAllowedTools } from "../tools/tool-registry.ts";
import { verifyIdentity } from "../tools/verify-identity.ts";
import { guard } from "./guard.ts";
import { persist } from "./persist.ts";

// ── Extraction types (output of extraction LLM) ───────────────────────────────

interface ExtractionResult {
  source_message_id: string;
  observations: FieldObservation[];
  policy_number?: string;
  caller_role?: "policyholder" | "representative";
  case_hints?: CaseHintObservation;
}

// ── Outer handler ─────────────────────────────────────────────────────────────

export interface HandleMessageOptions {
  sessionId: string;
  userMessage: string;
  model: ModelFn;            // conversation LLM
  extractionModel: ModelFn;  // dedicated extraction LLM (may be the same)
  priorMessages?: Message[]; // conversation history from previous turns
  emit?: (event: Event) => void | Promise<void>;
  nowIso?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  signal?: AbortSignal;
}

export async function handleMessage(opts: HandleMessageOptions): Promise<RunResult> {
  const {
    sessionId, userMessage, model, extractionModel,
    priorMessages = [],
    emit, signal, maxTurns = 8, maxToolCalls = 16,
  } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  // ── Step 1: Persist raw message ─────────────────────────────────────────────
  const messageId = `msg_${makeEventId()}`;

  // ── Step 2: Extract structured fields via dedicated extraction LLM ──────────
  const extracted = await extractFields(
    messageId, userMessage, sessionId, extractionModel, nowIso, signal
  );

  // ── Step 3: Validate and persist extracted observations ─────────────────────
  if (extracted && extracted.observations.length > 0) {
    const validObs = extracted.observations.filter(obs =>
      obs.status === "explicit" && obs.subject !== "unknown"
    );
    const ambiguousObs = extracted.observations.filter(obs =>
      obs.status === "ambiguous"
    );

    if (validObs.length > 0 || extracted.policy_number || extracted.caller_role || extracted.case_hints) {
      const events = getEvents(sessionId);
      appendEvent({
        event_id: makeEventId(),
        session_id: sessionId,
        seq: events.length,
        timestamp: nowIso,
        sop_version: SOP_VERSION,
        type: "user_information_recorded",
        payload: {
          source_message_id: messageId,
          accepted_fields: validObs,
          policy_number: extracted.policy_number,
          caller_role: extracted.caller_role,
          case_hints: extracted.case_hints,
        },
      });
    }

    if (ambiguousObs.length > 0) {
      const events = getEvents(sessionId);
      appendEvent({
        event_id: makeEventId(),
        session_id: sessionId,
        seq: events.length,
        timestamp: nowIso,
        sop_version: SOP_VERSION,
        type: "user_information_needs_clarification",
        payload: {
          source_message_id: messageId,
          ambiguous_fields: ambiguousObs,
          reason: "Ambiguous value — needs clarification before use in verification",
        },
      });
    }
  }

  // ── Step 4: Trigger identity verification if fields changed ─────────────────
  const factsBeforeVerify = reduceSessionEvents(getEvents(sessionId));
  const prevRevision = factsBeforeVerify.identity.identity_revision;

  // Only verify if: in VERIFY_ID, has ≥3 usable fields, no existing valid verification.
  const usableFieldCount = Object.keys(factsBeforeVerify.identity.provided_fields)
    .filter(f => !factsBeforeVerify.identity.pending_clarification.includes(f))
    .length;

  if (
    !factsBeforeVerify.identity.verification &&
    usableFieldCount >= 3 &&
    prevRevision > 0
  ) {
    verifyIdentity(sessionId);
  }

  // ── Step 5: Derive state and build initial context ──────────────────────────
  const events = getEvents(sessionId);
  const facts  = reduceSessionEvents(events);
  const state  = deriveSopState(facts);
  const runtimeContext = buildRuntimeContext(facts, state, nowIso);
  const tools  = getAllowedTools(state, sessionId, nowIso);

  // ── Step 6: Run conversation loop ───────────────────────────────────────────
  return runAgentLoop(userMessage, {
    systemPrompt: buildSystemPrompt(),
    runtimeContext,
    messages: [...priorMessages],  // carry history from previous turns
    tools,
  }, {
    model,
    signal,
    maxTurns,
    maxToolCalls,
    emit,

    prepareRequest(context) {
      // Re-derive on every turn in case tools changed session state.
      const ev    = getEvents(sessionId);
      const f     = reduceSessionEvents(ev);
      const s     = deriveSopState(f);
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
      // End the loop when the model produced a text response with no tool calls.
      if (message.toolCalls.length === 0 && results.length === 0) return "end";
      return undefined;
    },
  });
}

// ── Extraction helper ─────────────────────────────────────────────────────────

async function extractFields(
  messageId: string,
  userMessage: string,
  sessionId: string,
  extractionModel: ModelFn,
  nowIso: string,
  signal?: AbortSignal,
): Promise<ExtractionResult | null> {
  const facts = reduceSessionEvents(getEvents(sessionId));

  // Build pending_question from the last assistant message if available.
  // (Simplified: no pending question tracking in this version.)
  const extractionPrompt = buildExtractionPrompt(null);

  const input = JSON.stringify({
    source_message_id: messageId,
    session_id: sessionId,
    role: "user",
    content: userMessage,
  });

  try {
    const response = await extractionModel(
      {
        systemPrompt: extractionPrompt,
        runtimeContext: {},
        messages: [{ role: "user", content: input }],
        tools: [],
      },
      {
        signal,
        onTextDelta: async () => {},
      }
    );

    if (!response.content) return null;

    // Strip markdown code fences if present.
    const raw = response.content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(raw) as ExtractionResult;
    return parsed;
  } catch {
    // Extraction failure is non-fatal; session continues without extracted fields.
    return null;
  }
}
