import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { getClaimDetails } from "./get-claim-details.ts";

const require = createRequire(import.meta.url);
const ALL_CLAIMS: { case_id: string; party_id: string; case_type: string; status: string; summary: string; denial_reason?: string; documents_needed?: string[]; appeal_deadline?: string }[] = require(
  fileURLToPath(new URL("../fixtures/claims.json", import.meta.url))
);

export interface EmailDraft {
  discussed_cases: string[];
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

  const recipient = facts.customer_decisions.recipient_email ?? "";
  const partyId = facts.identity.verification?.party_id;
  if (!partyId) return { status: "not_authorized" };

  const discussedIds = facts.case_resolution.discussed_cases;
  const claims = discussedIds
    .map(id => ALL_CLAIMS.find(c => c.case_id === id && c.party_id === partyId))
    .filter(Boolean) as typeof ALL_CLAIMS;

  if (claims.length === 0) return { status: "not_authorized" };

  const claimBlocks = claims.map((claim, i) => {
    const lines = [
      `--- Claim ${i + 1} ---`,
      `Claim ID: ${claim.case_id}`,
      `Type: ${claim.case_type}`,
      `Status: ${claim.status}`,
      `Summary: ${claim.summary}`,
    ];
    if (claim.denial_reason) lines.push(`Denial reason: ${claim.denial_reason}`);
    if ((claim.documents_needed ?? []).length > 0) lines.push(`Missing documents: ${claim.documents_needed!.join(", ")}`);
    if (claim.appeal_deadline) lines.push(`Appeal deadline: ${claim.appeal_deadline}`);
    return lines.join("\n");
  });

  const subject = claims.length === 1
    ? `Summary: ${claims[0]!.case_type} claim ${claims[0]!.case_id}`
    : `Summary: ${claims.length} claims discussed`;

  const draft: EmailDraft = {
    discussed_cases: discussedIds,
    recipient_email: recipient,
    subject,
    body: claimBlocks.join("\n\n"),
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
      case_id: prepareResult.draft.discussed_cases.join(","),
      recipient_email: prepareResult.draft.recipient_email,
      send_id,
    },
  });

  return { status: "sent", send_id };
}
