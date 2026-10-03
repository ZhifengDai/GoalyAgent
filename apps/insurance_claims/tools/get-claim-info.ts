import { getClaimDetails } from "./get-claim-details.ts";
import { getClaimGuidance } from "./get-claim-guidance.ts";

export interface ClaimInfo {
  case_id: string;
  case_type: string;
  status: string;
  summary: string;
  denial_reason?: string;
  documents_needed: string[];
  appeal_deadline: string | null;
  deadline_status: "upcoming" | "passed" | "none";
  expected_reimbursement_amount?: string;
  allowed_max_amount?: string;
  net_pay?: string;
  document_guidance: Record<string, string>;
  document_alternative_guidance: Record<string, string>;
  submission_guidance: string;
  case_type_guidance: string | null;
}

export type GetClaimInfoResult =
  | { status: "ok"; info: ClaimInfo }
  | { status: "not_authorized" }
  | { status: "no_case_selected" };

export function getClaimInfo(sessionId: string, nowIso: string): GetClaimInfoResult {
  const detailsResult = getClaimDetails(sessionId);
  if (detailsResult.status === "not_authorized") return { status: "not_authorized" };
  if (detailsResult.status === "no_case_selected") return { status: "no_case_selected" };
  if (detailsResult.status === "not_found") return { status: "not_authorized" };

  const { claim } = detailsResult;

  const guidanceResult = getClaimGuidance(sessionId, nowIso);

  // Open or closed claims with no missing documents still get a full response.
  const guidance = guidanceResult.status === "ok" ? guidanceResult.guidance : null;

  return {
    status: "ok",
    info: {
      case_id: claim.case_id,
      case_type: claim.case_type,
      status: claim.status,
      summary: claim.summary,
      denial_reason: claim.denial_reason,
      documents_needed: guidance?.documents_needed ?? [],
      appeal_deadline: guidance?.appeal_deadline ?? claim.appeal_deadline ?? null,
      deadline_status: guidance?.deadline_status ?? "none",
      expected_reimbursement_amount: claim.expected_reimbursement_amount,
      allowed_max_amount: claim.allowed_max_amount,
      net_pay: claim.net_pay,
      document_guidance: guidance?.document_guidance ?? {},
      document_alternative_guidance: guidance?.document_alternative_guidance ?? {},
      submission_guidance: guidance?.submission_guidance ?? "",
      case_type_guidance: guidance?.case_type_guidance ?? null,
    },
  };
}
