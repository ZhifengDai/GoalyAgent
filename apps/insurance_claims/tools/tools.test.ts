import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents, type SessionFacts } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { verifyIdentity } from "./verify-identity.ts";
import { findClaims } from "./find-claims.ts";
import { selectClaim } from "./select-claim.ts";
import { getClaimDetails } from "./get-claim-details.ts";
import { getClaimGuidance } from "./get-claim-guidance.ts";
import { recordCustomerDecision } from "./record-customer-decision.ts";
import { sendSummaryEmail } from "./send-summary-email.ts";

// Each test uses a unique session ID to avoid shared state.
let sessionCounter = 0;
function newSession(): string { return `test-session-${++sessionCounter}`; }

function seedIdentity(sessionId: string) {
  appendEvent({
    event_id: makeEventId(), session_id: sessionId, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      accepted_fields: [
        { field: "name", subject: "caller", operation: "provide",
          raw_value: "Margaret Chen", evidence: "My name is Margaret Chen",
          normalized_value: "Margaret Chen", status: "explicit" },
        { field: "dob", subject: "caller", operation: "provide",
          raw_value: "1985-03-15", evidence: "DOB is 1985-03-15",
          normalized_value: "1985-03-15", status: "explicit" },
        { field: "ssn_last4", subject: "caller", operation: "provide",
          raw_value: "4472", evidence: "SSN last four is 4472",
          normalized_value: "4472", status: "explicit" },
      ],
      case_hints: { intent: "denial_question", case_type: "healthcare", reported_status: "denied", month: 1, year: null },
    },
  });
}

// ── verify-identity ───────────────────────────────────────────────────────────

test("verify-identity: returns verified for Margaret with correct fields", () => {
  const s = newSession();
  seedIdentity(s);
  const result = verifyIdentity(s);
  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.party_id, "P9");
    assert.ok(result.matched_fields.includes("name"));
    assert.ok(result.matched_fields.includes("dob"));
    assert.ok(result.matched_fields.includes("ssn_last4"));
  }
});

test("verify-identity: insufficient fields returns insufficient_information", () => {
  const s = newSession();
  appendEvent({
    event_id: makeEventId(), session_id: s, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      accepted_fields: [
        { field: "name", subject: "caller", operation: "provide",
          raw_value: "Margaret Chen", evidence: "My name is Margaret Chen",
          normalized_value: "Margaret Chen", status: "explicit" },
      ],
    },
  });
  const result = verifyIdentity(s);
  assert.equal(result.status, "insufficient_information");
});

test("verify-identity: national_id_last4 does not count as ssn_last4", () => {
  const s = newSession();
  // P12 has national_id_last4 6688 — must NOT verify as ssn_last4.
  appendEvent({
    event_id: makeEventId(), session_id: s, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      accepted_fields: [
        { field: "name", subject: "caller", operation: "provide",
          raw_value: "Ma Tian", evidence: "Ma Tian",
          normalized_value: "Ma Tian", status: "explicit" },
        { field: "dob", subject: "caller", operation: "provide",
          raw_value: "1964-09-10", evidence: "1964-09-10",
          normalized_value: "1964-09-10", status: "explicit" },
        { field: "ssn_last4", subject: "caller", operation: "provide",
          raw_value: "6688", evidence: "6688",
          normalized_value: "6688", status: "explicit" },
      ],
    },
  });
  const result = verifyIdentity(s);
  assert.notEqual(result.status, "verified");
});

test("verify-identity: name alias matches (Ya Wen Li / Yaven Li)", () => {
  const s = newSession();
  appendEvent({
    event_id: makeEventId(), session_id: s, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      accepted_fields: [
        { field: "name", subject: "caller", operation: "provide",
          raw_value: "Yaven Li", evidence: "Yaven Li",
          normalized_value: "Yaven Li", status: "explicit" },
        { field: "dob", subject: "caller", operation: "provide",
          raw_value: "1989-12-03", evidence: "1989-12-03",
          normalized_value: "1989-12-03", status: "explicit" },
        { field: "email", subject: "caller", operation: "provide",
          raw_value: "yawen.li@gmail.com", evidence: "yawen.li@gmail.com",
          normalized_value: "yawen.li@gmail.com", status: "explicit" },
      ],
    },
  });
  const result = verifyIdentity(s);
  assert.equal(result.status, "verified");
  if (result.status === "verified") assert.equal(result.party_id, "P13");
});

// ── find-claims ───────────────────────────────────────────────────────────────

test("find-claims: blocked before verification", () => {
  const s = newSession();
  seedIdentity(s);
  const result = findClaims(s);
  assert.equal(result.status, "not_authorized");
});

test("find-claims: returns only P9 claims after verification", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  const result = findClaims(s);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.ok(result.claims.length > 0);
    assert.ok(result.claims.every(c => ["CL-2048","CL-2011","CL-1899","CL-2102"].includes(c.case_id)));
  }
});

test("find-claims: filter by case_type, month and year narrows to CL-2048", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  // P9 has two January healthcare claims (2025 and 2026); year disambiguates.
  const result = findClaims(s, { case_type: "healthcare", month: 1, year: 2026 });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]!.case_id, "CL-2048");
  }
});

// ── select-claim + get-claim-details ─────────────────────────────────────────

test("select-claim: wrong owner is rejected", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  const result = selectClaim(s, "CL-3001", "caller requested");
  assert.equal(result.status, "wrong_owner");
});

test("full VERIFY_ID → RESOLVE_INTENT → PROCESS_CASE path for Margaret", () => {
  const s = newSession();
  seedIdentity(s);

  // Phase 1 → 2
  const verifyResult = verifyIdentity(s);
  assert.equal(verifyResult.status, "verified");

  // Phase 2: select CL-2048 using remembered case hint
  const selectResult = selectClaim(s, "CL-2048", "healthcare, January, denied — matches case hint");
  assert.equal(selectResult.status, "ok");

  // Phase 3: get details
  const detailsResult = getClaimDetails(s);
  assert.equal(detailsResult.status, "ok");
  if (detailsResult.status === "ok") {
    assert.equal(detailsResult.claim.case_id, "CL-2048");
    assert.equal(detailsResult.claim.status, "denied");
    assert.ok(detailsResult.claim.documents_needed?.includes("pathology report"));
  }
});

// ── get-claim-guidance + deadline ────────────────────────────────────────────

test("get-claim-guidance: deadline_status=passed when now is after appeal_deadline", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  selectClaim(s, "CL-2048", "test");

  // CL-2048 appeal_deadline is 2026-03-18, use a date after that.
  const result = getClaimGuidance(s, "2026-10-01T00:00:00Z");
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.guidance.deadline_status, "passed");
    assert.ok(result.guidance.documents_needed.includes("pathology report"));
  }
});

test("get-claim-guidance: deadline_status=upcoming when now is before appeal_deadline", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  selectClaim(s, "CL-2048", "test");

  const result = getClaimGuidance(s, "2026-03-01T00:00:00Z");
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.guidance.deadline_status, "upcoming");
});

// ── POST_PROCESS ──────────────────────────────────────────────────────────────

test("send-summary-email: no_consent when decision is skip", async () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  selectClaim(s, "CL-2048", "test");
  // Customer said skip → POST_PROCESS, but no send consent.
  recordCustomerDecision(s, "skip");
  const result = await sendSummaryEmail(s);
  assert.equal(result.status, "no_consent");
});

test("send-summary-email: succeeds with consent and is idempotent", async () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  selectClaim(s, "CL-2048", "test");
  recordCustomerDecision(s, "send", "margaret@email.com");

  const r1 = await sendSummaryEmail(s);
  assert.equal(r1.status, "sent");

  // Second call must not re-send.
  const r2 = await sendSummaryEmail(s);
  assert.equal(r2.status, "sent");
  if (r2.status === "sent") assert.equal(r2.send_id, "already_sent");
});
