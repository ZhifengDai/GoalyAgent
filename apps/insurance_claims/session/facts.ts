import type { IdentityField, SessionEvent } from "./events.ts";

// ── Fact types ────────────────────────────────────────────────────────────────

export interface ProviderFieldFact {
  subject: string;
  value: string;
  source_message_id: string;
  evidence: string;
  version: number;
}

export interface VerificationFact {
  status: "verified";
  party_id: string;
  matched_fields: IdentityField[];
  identity_revision: number;
  field_versions: Partial<Record<IdentityField, number>>;
  source_event_id: string;
}

export interface CaseHintFact {
  intent?: string;
  case_type?: string;
  reported_status?: string;
  month?: number;
  year?: number | null;
  source_message_id: string;
}

export interface VerificationFailureFact {
  status: "insufficient_information" | "no_match" | "ambiguous" | "conflict" | "unauthorized_representative";
  blocking_conflicts: string[];
  identity_revision: number;
}

export interface SessionFacts {
  revision: number;
  identity: {
    identity_revision: number;
    caller_role?: "policyholder" | "representative";
    representative_name?: string;
    policy_number?: string;
    provided_fields: Partial<Record<IdentityField, ProviderFieldFact>>;
    // Fields blocked from verification until clarification is resolved.
    pending_clarification: IdentityField[];
    verification: VerificationFact | null;
    // Last failed verification attempt (cleared on new identity_revision or success).
    verification_failure: VerificationFailureFact | null;
  };
  case_hints: CaseHintFact | null;
  case_resolution: {
    status: "unresolved" | "resolved";
    selected_case_id: string | null;
    selection_basis: string | null;
  };
  customer_decisions: {
    email_summary: "unknown" | "send" | "skip";
    recipient_email?: string;
  };
  email_sent: boolean;
  human_handoff: { status: "requested" | "queued" | "completed" } | null;
}

// ── Reducer ───────────────────────────────────────────────────────────────────

export function reduceSessionEvents(events: SessionEvent[]): SessionFacts {
  const facts: SessionFacts = {
    revision: 0,
    identity: {
      identity_revision: 0,
      provided_fields: {},
      pending_clarification: [],
      verification: null,
      verification_failure: null,
    },
    case_hints: null,
    case_resolution: { status: "unresolved", selected_case_id: null, selection_basis: null },
    customer_decisions: { email_summary: "unknown" },
    email_sent: false,
    human_handoff: null,
  };

  for (const event of events) {
    facts.revision = event.seq + 1;

    switch (event.type) {
      case "user_information_recorded": {
        const { payload } = event;
        let identityChanged = false;

        for (const obs of payload.accepted_fields) {
          if (obs.subject === "unknown" || obs.subject === "other") continue;
          // Caller's own name when they are a representative — stored separately.
          if (obs.subject === "caller" && obs.field === "name" && facts.identity.caller_role === "representative") {
            if (obs.operation === "withdraw") {
              delete facts.identity.representative_name;
            } else {
              facts.identity.representative_name = obs.normalized_value;
            }
            identityChanged = true;
            continue;
          }
          const existing = facts.identity.provided_fields[obs.field];
          const nextVersion = (existing?.version ?? 0) + 1;

          if (obs.operation === "withdraw") {
            delete facts.identity.provided_fields[obs.field];
            // Invalidate verification when a field is withdrawn.
            if (facts.identity.verification?.matched_fields.includes(obs.field)) {
              facts.identity.verification = null;
            }
            identityChanged = true;
          } else {
            // provide or correct
            if (existing && existing.value === obs.normalized_value) continue; // no-op
            facts.identity.provided_fields[obs.field] = {
              subject: obs.subject,
              value: obs.normalized_value,
              source_message_id: payload.source_message_id,
              evidence: obs.evidence,
              version: nextVersion,
            };
            // Invalidate verification when a field is corrected.
            if (obs.operation === "correct" && facts.identity.verification?.matched_fields.includes(obs.field)) {
              facts.identity.verification = null;
            }
            identityChanged = true;
          }

          // Remove from pending clarification list if now resolved.
          facts.identity.pending_clarification = facts.identity.pending_clarification.filter(
            f => f !== obs.field
          );
        }

        if (payload.caller_role) facts.identity.caller_role = payload.caller_role;
        if (payload.policy_number) facts.identity.policy_number = payload.policy_number;
        if (payload.case_hints) {
          facts.case_hints = { ...payload.case_hints, source_message_id: payload.source_message_id };
        }
        if (identityChanged) {
          facts.identity.identity_revision++;
          // A field change invalidates any prior failure — fresh fields, fresh attempt.
          facts.identity.verification_failure = null;
        }
        break;
      }

      case "user_information_needs_clarification": {
        for (const obs of event.payload.ambiguous_fields) {
          if (!facts.identity.pending_clarification.includes(obs.field)) {
            facts.identity.pending_clarification.push(obs.field);
          }
        }
        break;
      }

      case "identity_verification_completed": {
        const { payload } = event;
        // Only apply if this result targets the current identity revision.
        if (payload.identity_revision !== facts.identity.identity_revision) break;
        facts.identity.verification = {
          status: "verified",
          party_id: payload.party_id,
          matched_fields: payload.matched_fields,
          identity_revision: payload.identity_revision,
          field_versions: payload.field_versions,
          source_event_id: event.event_id,
        };
        facts.identity.verification_failure = null;
        break;
      }

      case "identity_verification_failed": {
        // A failed result targeted an outdated revision: ignore.
        if (event.payload.identity_revision !== facts.identity.identity_revision) break;
        // Clear any stale verification and record why it failed.
        facts.identity.verification = null;
        facts.identity.verification_failure = {
          status: event.payload.status,
          blocking_conflicts: event.payload.blocking_conflicts,
          identity_revision: event.payload.identity_revision,
        };
        break;
      }

      case "identity_verification_invalidated": {
        facts.identity.verification = null;
        break;
      }

      case "claim_selected": {
        facts.case_resolution = {
          status: "resolved",
          selected_case_id: event.payload.case_id,
          selection_basis: event.payload.selection_basis,
        };
        break;
      }

      case "customer_decision_recorded": {
        const { payload } = event;
        if (payload.topic === "email_summary") {
          facts.customer_decisions.email_summary = payload.decision;
          if (payload.recipient_email) facts.customer_decisions.recipient_email = payload.recipient_email;
        }
        break;
      }

      case "email_sent": {
        facts.email_sent = true;
        break;
      }

      case "human_handoff_requested": {
        facts.human_handoff = { status: event.payload.status };
        break;
      }
    }
  }

  return facts;
}
