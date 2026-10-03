import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";

export type RestartClaimSelectionResult =
  | { status: "ok"; discussed_cases: string[] }
  | { status: "not_authorized" };

export function restartClaimSelection(
  sessionId: string,
  reason: string
): RestartClaimSelectionResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (state.phase !== "PROCESS_CASE") {
    return { status: "not_authorized" };
  }

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: events.length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "claim_selection_reset",
    payload: { reason },
  });

  return {
    status: "ok",
    discussed_cases: facts.case_resolution.discussed_cases,
  };
}
