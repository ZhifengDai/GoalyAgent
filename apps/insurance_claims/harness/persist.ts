import type { ToolCall, ToolMessage, Context } from "../../../agent-loop/types.ts";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { buildRuntimeContext } from "../prompts/context-builder.ts";
import { getAllowedTools } from "../tools/tool-registry.ts";
import { verifyIdentity } from "../tools/verify-identity.ts";

/**
 * afterToolCall hook — triggered after every tool the LLM calls.
 *
 * For record_user_information: check if we now have ≥3 usable identity
 * fields and no existing verification. If so, run verifyIdentity immediately
 * so the LLM sees the updated phase in its next request within this turn.
 *
 * For all tools: refresh Facts → State → RuntimeContext so prepareRequest
 * picks up the latest state without an extra round-trip.
 */
export async function persist(
  call: ToolCall,
  _result: ToolMessage,
  context: Context,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  if (call.name === "record_user_information") {
    const facts = reduceSessionEvents(getEvents(sessionId));
    const usableFieldCount = Object.keys(facts.identity.provided_fields)
      .filter(f => !facts.identity.pending_clarification.includes(f as never))
      .length;

    if (
      !facts.identity.verification &&
      usableFieldCount >= 3 &&
      facts.identity.identity_revision > 0
    ) {
      verifyIdentity(sessionId);
    }
  }

  // Refresh context regardless of which tool ran.
  const ev = getEvents(sessionId);
  const f  = reduceSessionEvents(ev);
  const s  = deriveSopState(f);
  context.runtimeContext = buildRuntimeContext(f, s, nowIso);
  context.tools          = getAllowedTools(s, sessionId, nowIso);
}
