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

export interface ClaimSummary {
  case_id: string;
  case_type: string;
  created_at: string;
  status: string;
  summary: string;
}

export type FindClaimsResult =
  | { status: "ok"; claims: ClaimSummary[] }
  | { status: "not_authorized" }
  | { status: "no_claims" };

export function findClaims(
  sessionId: string,
  filter?: { case_type?: string; month?: number; year?: number; reported_status?: string }
): FindClaimsResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  // Must be in RESOLVE_INTENT or later and have a verified identity.
  if (!facts.identity.verification || state.phase === "VERIFY_ID") {
    return { status: "not_authorized" };
  }

  const partyId = facts.identity.verification.party_id;
  const discussed = new Set(facts.case_resolution.discussed_cases);
  let claims = ALL_CLAIMS.filter(c => c.party_id === partyId && !discussed.has(c.case_id));

  // Apply optional filters derived from case hints.
  if (filter?.case_type) {
    claims = claims.filter(c => c.case_type === filter.case_type);
  }
  if (filter?.reported_status) {
    claims = claims.filter(c => c.status === filter.reported_status);
  }
  if (filter?.month != null) {
    claims = claims.filter(c => {
      const month = new Date(c.created_at).getMonth() + 1;
      return month === filter.month;
    });
  }
  if (filter?.year != null) {
    claims = claims.filter(c => {
      const year = new Date(c.created_at).getFullYear();
      return year === filter.year;
    });
  }

  if (claims.length === 0) return { status: "no_claims" };

  return {
    status: "ok",
    claims: claims.map(c => ({
      case_id: c.case_id,
      case_type: c.case_type,
      created_at: c.created_at,
      status: c.status,
      summary: c.summary,
    })),
  };
}
