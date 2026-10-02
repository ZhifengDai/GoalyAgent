import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";

export type RequestHumanHandoffResult =
  | { status: "requested" }
  | { status: "already_requested" };

export function requestHumanHandoff(sessionId: string, reason: string): RequestHumanHandoffResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);

  if (facts.human_handoff) return { status: "already_requested" };

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: events.length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "human_handoff_requested",
    payload: { reason, status: "requested" },
  });

  return { status: "requested" };
}
