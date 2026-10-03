import type { SessionFacts } from "../session/facts.ts";
import type { SopState } from "../session/state.ts";
import type { Json } from "../../../agent-loop/types.ts";

export function buildRuntimeContext(
  facts: SessionFacts,
  state: SopState,
  nowIso: string,
): Json {
  const base = {
    sop_version: "insurance-sop-v1",
    session_revision: facts.revision,
    current_time: nowIso,
    phase: state.phase,
    next_requirement: state.next_requirement,
    allowed_tools: state.allowed_tools,
  };

  switch (state.phase) {
    case "VERIFY_ID": {
      const failure = facts.identity.verification_failure;
      const collectedCount = Object.keys(facts.identity.provided_fields).length;
      // When verification was attempted but failed, fields are sufficient but incorrect.
      const verificationAttempted = failure !== null && collectedCount >= 3;
      return {
        ...base,
        identity: {
          status: verificationAttempted ? "verification_failed" : "collecting",
          verification_failure: failure
            ? {
                reason: failure.status,
                // Never reveal which specific field conflicted — only say the attempt failed.
                hint: failure.status === "conflict"
                  ? "One or more fields did not match our records. Ask the caller to double-check their details."
                  : failure.status === "no_match"
                  ? "No matching record found. The caller may not be the policyholder or fields may be incorrect."
                  : failure.status === "ambiguous"
                  ? "Multiple potential matches found. Collect additional fields to disambiguate."
                  : failure.status === "unauthorized_representative"
                  ? "Caller's name is not listed as an authorized representative for this account."
                  : null,
              }
            : null,
          collected_fields: Object.keys(facts.identity.provided_fields),
          missing_field_options: state.missing_identity_fields,
          pending_clarification: state.pending_clarification,
          additional_matches_required: verificationAttempted
            ? 0
            : Math.max(0, 3 - collectedCount),
          representative_name_collected: facts.identity.caller_role === "representative"
            ? (facts.identity.representative_name ?? null) !== null
            : undefined,
        },
        // Surface remembered hints so the model knows not to re-ask.
        remembered_hints: facts.case_hints
          ? {
              intent: facts.case_hints.intent ?? null,
              case_type: facts.case_hints.case_type ?? null,
              reported_status: facts.case_hints.reported_status ?? null,
              month: facts.case_hints.month ?? null,
              year: facts.case_hints.year ?? null,
            }
          : null,
        case_access: "denied",
      };
    }

    case "RESOLVE_INTENT":
      return {
        ...base,
        identity: {
          status: "verified",
          party_id: state.party_id,
        },
        remembered_hints: facts.case_hints
          ? {
              intent: facts.case_hints.intent ?? null,
              case_type: facts.case_hints.case_type ?? null,
              reported_status: facts.case_hints.reported_status ?? null,
              month: facts.case_hints.month ?? null,
              year: facts.case_hints.year ?? null,
            }
          : null,
        case_resolution: {
          status: "unresolved",
          instruction: "Use remembered hints to query and identify the target claim.",
        },
      };

    case "PROCESS_CASE":
      return {
        ...base,
        identity: {
          status: "verified",
          party_id: state.party_id,
        },
        case_resolution: {
          status: "resolved",
          selected_case_id: facts.case_resolution.selected_case_id,
        },
        email_decision: facts.customer_decisions.email_summary,
      };

    case "POST_PROCESS":
      return {
        ...base,
        identity: {
          status: "verified",
          party_id: state.party_id,
        },
        case_resolution: {
          status: "resolved",
          selected_case_id: facts.case_resolution.selected_case_id,
        },
        email_decision: facts.customer_decisions.email_summary,
        recipient_email: facts.customer_decisions.recipient_email ?? null,
        email_sent: facts.email_sent,
      };

    case "DONE":
      return {
        ...base,
        identity: { status: "verified", party_id: state.party_id },
        email_sent: facts.email_sent,
      };

    case "HUMAN_HANDOFF":
      return {
        ...base,
        handoff_status: facts.human_handoff?.status ?? "requested",
      };
  }
}
