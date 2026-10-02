import type { ToolCall, ToolMessage, Context } from "../../../agent-loop/types.ts";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { buildRuntimeContext } from "../prompts/context-builder.ts";
import { getAllowedTools } from "../tools/tool-registry.ts";

/**
 * afterToolCall hook — refresh Facts, State, and context after every tool result.
 * This ensures the next prepareRequest sees up-to-date state without a round-trip.
 */
export async function persist(
  _call: ToolCall,
  _result: ToolMessage,
  context: Context,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  // Tool functions persist their own events internally (appendEvent inside execute).
  // Here we only need to refresh the in-memory context so the next model request
  // reflects the latest state without waiting for prepareRequest.
  const events = getEvents(sessionId);
  const facts  = reduceSessionEvents(events);
  const state  = deriveSopState(facts);

  context.runtimeContext = buildRuntimeContext(facts, state, nowIso);
  context.tools          = getAllowedTools(state, sessionId, nowIso);
}
