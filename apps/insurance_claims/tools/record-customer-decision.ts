import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";

export type RecordDecisionResult =
  | { status: "ok" }
  | { status: "not_authorized" }
  | { status: "ambiguous"; reason: string };

export function recordCustomerDecision(
  sessionId: string,
  decision: "send" | "skip" | "unknown",
  recipientEmail?: string
): RecordDecisionResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (!["PROCESS_CASE", "POST_PROCESS"].includes(state.phase)) {
    return { status: "not_authorized" };
  }

  // "send" requires a recipient email.
  if (decision === "send" && !recipientEmail) {
    return { status: "ambiguous", reason: "send decision requires a recipient email address" };
  }

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: events.length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "customer_decision_recorded",
    payload: { source_message_id: "", topic: "email_summary", decision, recipient_email: recipientEmail },
  });

  return { status: "ok" };
}
