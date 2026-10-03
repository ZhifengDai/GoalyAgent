import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import { reduceSessionEvents, type SessionFacts } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import { verifyIdentity } from "./verify-identity.ts";
import { findClaims } from "./find-claims.ts";
import { selectClaim } from "./select-claim.ts";
import { getClaimDetails } from "./get-claim-details.ts";
import { getClaimGuidance } from "./get-claim-guidance.ts";
import { getClaimInfo } from "./get-claim-info.ts";
import { recordCustomerDecision } from "./record-customer-decision.ts";
import { restartClaimSelection } from "./restart-claim-selection.ts";
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

// ── restart_claim_selection ───────────────────────────────────────────────────

test("restart_claim_selection: resets to RESOLVE_INTENT, keeps discussed_cases", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);
  selectClaim(s, "CL-2048", "denied healthcare");

  const result = restartClaimSelection(s, "caller wants to check auto claim");
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.discussed_cases, ["CL-2048"]);
  }

  const facts = reduceSessionEvents(getEvents(s));
  const state = deriveSopState(facts);
  assert.equal(state.phase, "RESOLVE_INTENT");
  assert.deepEqual(facts.case_resolution.discussed_cases, ["CL-2048"]);
  assert.equal(facts.case_resolution.selected_case_id, null);
});

test("restart_claim_selection: second claim added to discussed_cases", () => {
  const s = newSession();
  seedIdentity(s);
  verifyIdentity(s);

  selectClaim(s, "CL-2048", "denied healthcare");
  restartClaimSelection(s, "caller wants auto claim");
  selectClaim(s, "CL-2102", "open auto claim");

  const facts = reduceSessionEvents(getEvents(s));
  assert.deepEqual(facts.case_resolution.discussed_cases, ["CL-2048", "CL-2102"]);
  assert.equal(facts.case_resolution.selected_case_id, "CL-2102");
});

// ── Representative verification ───────────────────────────────────────────────

function seedRepresentative(sessionId: string, repName: string) {
  appendEvent({
    event_id: makeEventId(), session_id: sessionId, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      caller_role: "representative",
      accepted_fields: [
        // David's own name (subject: caller → stored as representative_name)
        { field: "name", subject: "caller", operation: "provide",
          raw_value: repName, evidence: `My name is ${repName}`,
          normalized_value: repName, status: "explicit" },
        // Margaret's policyholder fields (subject: policyholder)
        { field: "name", subject: "policyholder", operation: "provide",
          raw_value: "Margaret Chen", evidence: "policyholder is Margaret Chen",
          normalized_value: "Margaret Chen", status: "explicit" },
        { field: "dob", subject: "policyholder", operation: "provide",
          raw_value: "1985-03-15", evidence: "her DOB is 1985-03-15",
          normalized_value: "1985-03-15", status: "explicit" },
        { field: "ssn_last4", subject: "policyholder", operation: "provide",
          raw_value: "4472", evidence: "SSN last four is 4472",
          normalized_value: "4472", status: "explicit" },
      ],
    },
  });
}

test("representative: David Chen verified → party_id is Margaret's P9", () => {
  const s = newSession();
  seedRepresentative(s, "David Chen");
  const result = verifyIdentity(s);
  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.party_id, "P9");
  }
});

test("representative: unauthorized rep name returns unauthorized_representative", () => {
  const s = newSession();
  seedRepresentative(s, "John Smith"); // not in representatives.json for P9
  const result = verifyIdentity(s);
  assert.equal(result.status, "unauthorized_representative");
});

// ── RESOLVE_INTENT: Ma Tian (P12, national_id) ───────────────────────────────

function seedMaTian(sessionId: string) {
  appendEvent({
    event_id: makeEventId(), session_id: sessionId, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      accepted_fields: [
        { field: "name", subject: "caller", operation: "provide",
          raw_value: "Ma Tian", evidence: "My name is Ma Tian",
          normalized_value: "Ma Tian", status: "explicit" },
        { field: "dob", subject: "caller", operation: "provide",
          raw_value: "1964-09-10", evidence: "DOB is 1964-09-10",
          normalized_value: "1964-09-10", status: "explicit" },
        { field: "national_id_last4", subject: "caller", operation: "provide",
          raw_value: "6688", evidence: "national ID last four is 6688",
          normalized_value: "6688", status: "explicit" },
      ],
    },
  });
}

test("RESOLVE_INTENT: Ma Tian finds exactly one claim CL-3001", () => {
  const s = newSession();
  seedMaTian(s);
  verifyIdentity(s);
  const result = findClaims(s);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]!.case_id, "CL-3001");
    assert.equal(result.claims[0]!.status, "denied");
  }
});

test("RESOLVE_INTENT: Ma Tian selects CL-3001 and reaches PROCESS_CASE", () => {
  const s = newSession();
  seedMaTian(s);
  verifyIdentity(s);
  const select = selectClaim(s, "CL-3001", "single denied healthcare claim");
  assert.equal(select.status, "ok");
  const details = getClaimDetails(s);
  assert.equal(details.status, "ok");
  if (details.status === "ok") {
    assert.equal(details.claim.case_id, "CL-3001");
    assert.equal(details.claim.party_id, "P12");
  }
});

// ── RESOLVE_INTENT: Ava Lopez (P7) — no claims ───────────────────────────────

test("RESOLVE_INTENT: Ava Lopez has no claims after verification", () => {
  const s = newSession();
  appendEvent({
    event_id: makeEventId(), session_id: s, seq: 0,
    timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
    type: "user_information_recorded",
    payload: {
      source_message_id: "msg_01",
      accepted_fields: [
        { field: "name", subject: "caller", operation: "provide",
          raw_value: "Ava Lopez", evidence: "My name is Ava Lopez",
          normalized_value: "Ava Lopez", status: "explicit" },
        { field: "dob", subject: "caller", operation: "provide",
          raw_value: "1990-08-21", evidence: "DOB is 1990-08-21",
          normalized_value: "1990-08-21", status: "explicit" },
        { field: "ssn_last4", subject: "caller", operation: "provide",
          raw_value: "9180", evidence: "SSN last four is 9180",
          normalized_value: "9180", status: "explicit" },
      ],
    },
  });
  verifyIdentity(s);
  // P7 has no claims in fixtures — must return no_claims, not an error.
  const result = findClaims(s);
  assert.equal(result.status, "no_claims");
});

// ── PROCESS_CASE: open claim (CL-2102) ───────────────────────────────────────

test("PROCESS_CASE: open claim get_claim_info returns deadline_status=none and empty documents", () => {
  const s = newSession();
  seedIdentity(s); // Margaret Chen / P9
  verifyIdentity(s);
  const select = selectClaim(s, "CL-2102", "open auto claim");
  assert.equal(select.status, "ok");

  const result = getClaimInfo(s, new Date().toISOString());
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.info.status, "open");
    assert.equal(result.info.denial_reason, undefined);
    assert.deepEqual(result.info.documents_needed, []);
    assert.equal(result.info.deadline_status, "none");
  }
});
