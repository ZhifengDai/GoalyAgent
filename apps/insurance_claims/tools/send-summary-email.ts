import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { getClaimDetails } from "./get-claim-details.ts";

export interface EmailDraft {
  case_id: string;
  recipient_email: string;
  subject: string;
  body: string;
}

export type PrepareSummaryEmailResult =
  | { status: "ok"; draft: EmailDraft }
  | { status: "not_authorized" }
  | { status: "no_consent" };

export type SendSummaryEmailResult =
  | { status: "sent"; send_id: string }
  | { status: "not_authorized" }
  | { status: "no_consent" }
  | { status: "failed"; reason: string };

export function prepareSummaryEmail(sessionId: string): PrepareSummaryEmailResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (!["POST_PROCESS"].includes(state.phase)) return { status: "not_authorized" };
  if (facts.customer_decisions.email_summary !== "send") return { status: "no_consent" };

  const detailsResult = getClaimDetails(sessionId);
  if (detailsResult.status !== "ok") return { status: "not_authorized" };

  const { claim } = detailsResult;
  const recipient = facts.customer_decisions.recipient_email ?? "";

  const docLines = (claim.documents_needed ?? []).length > 0
    ? `\nMissing documents: ${claim.documents_needed!.join(", ")}.`
    : "";
  const deadlineLines = claim.appeal_deadline
    ? `\nAppeal deadline: ${claim.appeal_deadline}.`
    : "";

  const draft: EmailDraft = {
    case_id: claim.case_id,
    recipient_email: recipient,
    subject: `Summary: ${claim.case_type} claim ${claim.case_id}`,
    body: [
      `Claim ID: ${claim.case_id}`,
      `Type: ${claim.case_type}`,
      `Status: ${claim.status}`,
      `Summary: ${claim.summary}`,
      claim.denial_reason ? `Denial reason: ${claim.denial_reason}` : "",
      docLines,
      deadlineLines,
    ].filter(Boolean).join("\n"),
  };

  return { status: "ok", draft };
}

export async function sendSummaryEmail(sessionId: string): Promise<SendSummaryEmailResult> {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (!["POST_PROCESS"].includes(state.phase)) return { status: "not_authorized" };
  if (facts.customer_decisions.email_summary !== "send") return { status: "no_consent" };
  if (facts.email_sent) return { status: "sent", send_id: "already_sent" };

  const prepareResult = prepareSummaryEmail(sessionId);
  if (prepareResult.status !== "ok") return { status: prepareResult.status };

  // Simulate send (replace with real email service in production).
  const send_id = `send_${Date.now()}`;

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: getEvents(sessionId).length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "email_sent",
    payload: {
      case_id: prepareResult.draft.case_id,
      recipient_email: prepareResult.draft.recipient_email,
      send_id,
    },
  });

  return { status: "sent", send_id };
}
