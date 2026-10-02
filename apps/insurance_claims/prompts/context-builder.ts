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
    case "VERIFY_ID":
      return {
        ...base,
        identity: {
          status: "pending",
          collected_fields: Object.keys(facts.identity.provided_fields),
          missing_field_options: state.missing_identity_fields,
          pending_clarification: state.pending_clarification,
          additional_matches_required:
            Math.max(0, 3 - Object.keys(facts.identity.provided_fields).length),
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
