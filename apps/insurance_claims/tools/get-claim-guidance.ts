import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { getClaimDetails } from "./get-claim-details.ts";

const require = createRequire(import.meta.url);
const GUIDELINES: Guidelines = require(
  fileURLToPath(new URL("../fixtures/required_document_guideline.json", import.meta.url))
);

interface Guidelines {
  default_guidance: Record<string, string>;
  case_type_guidance: Record<string, Record<string, string>>;
  document_guidance: Record<string, Record<string, string>>;
  document_alternative_guidance: Record<string, Record<string, string>>;
  claim_followup_settings: Record<string, Record<string, string>>;
  claim_followup_guidance: FollowupRule[];
  claim_followup_fallback: Record<string, string>;
}

interface FollowupRule {
  topic: string;
  intent_hints: string[];
  requires_documents: boolean;
  match_any?: string[];
  en: string;
}

export interface ClaimGuidance {
  case_id: string;
  documents_needed: string[];
  appeal_deadline: string | null;
  deadline_status: "upcoming" | "passed" | "none";
  document_guidance: Record<string, string>;
  document_alternative_guidance: Record<string, string>;
  submission_guidance: string;
  case_type_guidance: string | null;
  followup_rules: Array<{ topic: string; text: string }>;
}

export type GetClaimGuidanceResult =
  | { status: "ok"; guidance: ClaimGuidance }
  | { status: "not_authorized" }
  | { status: "no_documents_needed" };

export function getClaimGuidance(sessionId: string, nowIso?: string): GetClaimGuidanceResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);

  if (!facts.identity.verification || !["PROCESS_CASE", "POST_PROCESS"].includes(state.phase)) {
    return { status: "not_authorized" };
  }

  const detailsResult = getClaimDetails(sessionId);
  if (detailsResult.status !== "ok") return { status: "not_authorized" };

  const { claim } = detailsResult;
  const docs = claim.documents_needed ?? [];
  if (docs.length === 0) return { status: "no_documents_needed" };

  const now = nowIso ? new Date(nowIso) : new Date();

  let deadlineStatus: "upcoming" | "passed" | "none" = "none";
  if (claim.appeal_deadline) {
    deadlineStatus = new Date(claim.appeal_deadline) >= now ? "upcoming" : "passed";
  }

  const docGuidance: Record<string, string> = {};
  const docAltGuidance: Record<string, string> = {};
  for (const doc of docs) {
    if (GUIDELINES.document_guidance[doc]?.en) {
      docGuidance[doc] = GUIDELINES.document_guidance[doc].en;
    }
    const altKey = GUIDELINES.document_alternative_guidance[doc] ? doc : "default";
    docAltGuidance[doc] = GUIDELINES.document_alternative_guidance[altKey]?.en ?? "";
  }

  const caseTypeGuidance = GUIDELINES.case_type_guidance[claim.case_type]?.en ?? null;

  const followupRules = GUIDELINES.claim_followup_guidance
    .filter(rule => rule.requires_documents && docs.length > 0)
    .map(rule => {
      const text = rule.en
        .replace("{case_id}", claim.case_id)
        .replace("{documents}", docs.join(" and "))
        .replace(
          "{average_processing_time_after_submission}",
          GUIDELINES.claim_followup_settings.average_processing_time_after_submission?.en ?? "usually less than a week"
        );
      return { topic: rule.topic, text };
    });

  return {
    status: "ok",
    guidance: {
      case_id: claim.case_id,
      documents_needed: docs,
      appeal_deadline: claim.appeal_deadline ?? null,
      deadline_status: deadlineStatus,
      document_guidance: docGuidance,
      document_alternative_guidance: docAltGuidance,
      submission_guidance: GUIDELINES.default_guidance.en,
      case_type_guidance: caseTypeGuidance,
      followup_rules: followupRules,
    },
  };
}
