import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";

const require = createRequire(import.meta.url);
const ALL_CLAIMS: Claim[] = require(
  fileURLToPath(new URL("../fixtures/claims.json", import.meta.url))
);

interface Claim {
  case_id: string;
  party_id: string;
  case_type: string;
  created_at: string;
  status: string;
  summary: string;
  denial_reason?: string;
  documents_needed?: string[];
  appeal_deadline?: string;
  expected_reimbursement_amount?: string;
  allowed_max_amount?: string;
  net_pay?: string;
  net_fee?: string;
}

export type GetClaimDetailsResult =
  | { status: "ok"; claim: Claim }
  | { status: "not_authorized" }
  | { status: "no_case_selected" }
  | { status: "not_found" };

export function getClaimDetails(sessionId: string): GetClaimDetailsResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  // Requires PROCESS_CASE or POST_PROCESS.
  if (!facts.identity.verification || !["PROCESS_CASE", "POST_PROCESS"].includes(state.phase)) {
    return { status: "not_authorized" };
  }

  const caseId = facts.case_resolution.selected_case_id;
  if (!caseId) return { status: "no_case_selected" };

  const partyId = facts.identity.verification.party_id;
  const claim = ALL_CLAIMS.find(c => c.case_id === caseId && c.party_id === partyId);
  if (!claim) return { status: "not_found" };

  return { status: "ok", claim };
}
