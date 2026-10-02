import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";

const require = createRequire(import.meta.url);
const ALL_CLAIMS: { case_id: string; party_id: string }[] = require(
  fileURLToPath(new URL("../fixtures/claims.json", import.meta.url))
);

export type SelectClaimResult =
  | { status: "ok"; case_id: string }
  | { status: "not_authorized" }
  | { status: "not_found" }
  | { status: "wrong_owner" };

export function selectClaim(
  sessionId: string,
  caseId: string,
  selectionBasis: string
): SelectClaimResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (!facts.identity.verification || state.phase === "VERIFY_ID") {
    return { status: "not_authorized" };
  }

  const partyId = facts.identity.verification.party_id;
  const claim = ALL_CLAIMS.find(c => c.case_id === caseId);

  if (!claim) return { status: "not_found" };
  if (claim.party_id !== partyId) return { status: "wrong_owner" };

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: events.length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "claim_selected",
    payload: { case_id: caseId, selection_basis: selectionBasis },
  });

  return { status: "ok", case_id: caseId };
}
