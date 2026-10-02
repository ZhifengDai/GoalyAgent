export const SOP_VERSION = "insurance-sop-v1" as const;

// ── Identity fields the extraction LLM may observe ───────────────────────────

export type IdentityField = "name" | "dob" | "phone" | "email" | "ssn_last4";
export type Subject = "caller" | "policyholder" | "other" | "unknown";
export type Operation = "provide" | "correct" | "withdraw";
export type ObservationStatus = "explicit" | "ambiguous";

export interface FieldObservation {
  field: IdentityField;
  subject: Subject;
  operation: Operation;
  raw_value: string;
  evidence: string;
  normalized_value: string;
  status: ObservationStatus;
}

export interface CaseHintObservation {
  intent?: string;
  case_type?: string;
  reported_status?: string;
  month?: number;
  year?: number | null;
}

// ── Event payloads ────────────────────────────────────────────────────────────

export interface UserInformationRecordedPayload {
  source_message_id: string;
  accepted_fields: FieldObservation[];
  policy_number?: string;
  caller_role?: "policyholder" | "representative";
  case_hints?: CaseHintObservation;
}

export interface UserInformationNeedsClarificationPayload {
  source_message_id: string;
  ambiguous_fields: FieldObservation[];
  reason: string;
}

export interface IdentityVerificationCompletedPayload {
  identity_revision: number;
  field_versions: Partial<Record<IdentityField, number>>;
  status: "verified";
  party_id: string;
  matched_fields: IdentityField[];
}

export interface IdentityVerificationFailedPayload {
  identity_revision: number;
  status: "insufficient_information" | "no_match" | "ambiguous" | "conflict";
  blocking_conflicts: string[];
}

export interface IdentityVerificationInvalidatedPayload {
  reason: "field_corrected" | "field_withdrawn" | "role_changed";
  affected_fields: IdentityField[];
}

export interface ClaimSelectedPayload {
  case_id: string;
  selection_basis: string;
}

export interface CustomerDecisionPayload {
  source_message_id: string;
  topic: "email_summary";
  decision: "send" | "skip" | "unknown";
  recipient_email?: string;
}

export interface EmailSentPayload {
  case_id: string;
  recipient_email: string;
  send_id: string;
}

export interface HumanHandoffRequestedPayload {
  reason: string;
  status: "requested" | "queued" | "completed";
}

// ── Discriminated union of all event types ────────────────────────────────────

export type SessionEvent = {
  event_id: string;
  session_id: string;
  seq: number;
  timestamp: string;
  sop_version: typeof SOP_VERSION;
} & (
  | { type: "user_information_recorded";           payload: UserInformationRecordedPayload }
  | { type: "user_information_needs_clarification"; payload: UserInformationNeedsClarificationPayload }
  | { type: "identity_verification_completed";     payload: IdentityVerificationCompletedPayload }
  | { type: "identity_verification_failed";        payload: IdentityVerificationFailedPayload }
  | { type: "identity_verification_invalidated";   payload: IdentityVerificationInvalidatedPayload }
  | { type: "claim_selected";                      payload: ClaimSelectedPayload }
  | { type: "customer_decision_recorded";          payload: CustomerDecisionPayload }
  | { type: "email_sent";                          payload: EmailSentPayload }
  | { type: "human_handoff_requested";             payload: HumanHandoffRequestedPayload }
);

// ── In-memory store (replace with DB in production) ──────────────────────────

const store = new Map<string, SessionEvent[]>();

export function appendEvent(event: SessionEvent): void {
  const list = store.get(event.session_id) ?? [];
  const expected = list.length;
  if (event.seq !== expected) {
    throw new Error(
      `Sequence conflict: expected seq ${expected}, got ${event.seq} for session ${event.session_id}`
    );
  }
  list.push(event);
  store.set(event.session_id, list);
}

export function getEvents(sessionId: string): SessionEvent[] {
  return store.get(sessionId) ?? [];
}

let _eventCounter = 0;
export function makeEventId(): string {
  return `evt_${Date.now()}_${++_eventCounter}`;
}
