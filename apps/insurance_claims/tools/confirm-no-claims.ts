import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";

export type ConfirmNoClaimsResult =
  | { status: "ok" }
  | { status: "not_authorized" };

export function confirmNoClaims(sessionId: string, reason: string): ConfirmNoClaimsResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (state.phase !== "RESOLVE_INTENT") return { status: "not_authorized" };

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: events.length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "no_claims_confirmed",
    payload: { reason },
  });

  return { status: "ok" };
}
