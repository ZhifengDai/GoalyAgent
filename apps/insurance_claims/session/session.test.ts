import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "./events.ts";
import { reduceSessionEvents } from "./facts.ts";
import { deriveSopState } from "./state.ts";

const SESSION = "test-margaret";
let seq = 0;

function nextSeq() { return seq++; }

test("VERIFY_ID: starts with no fields, stays in VERIFY_ID", () => {
  const facts = reduceSessionEvents([]);
  const state = deriveSopState(facts);
  assert.equal(state.phase, "VERIFY_ID");
  assert.equal(state.party_id, null);
  assert.equal(state.missing_identity_fields.length, 5);
});

test("VERIFY_ID: recording two fields is not enough to advance", () => {
  const events = [
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "user_information_recorded" as const,
      payload: {
        source_message_id: "msg_01",
        accepted_fields: [
          { field: "name" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "Margaret Chen", evidence: "My name is Margaret Chen",
            normalized_value: "Margaret Chen", status: "explicit" as const },
          { field: "dob" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "1985-03-15", evidence: "DOB is 1985-03-15",
            normalized_value: "1985-03-15", status: "explicit" as const },
        ],
      },
    },
  ];
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);
  assert.equal(state.phase, "VERIFY_ID");
  assert.equal(Object.keys(facts.identity.provided_fields).length, 2);
  assert.ok(state.missing_identity_fields.length > 0);
});

test("VERIFY_ID → RESOLVE_INTENT: three fields + verification completed", () => {
  const events = [
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "user_information_recorded" as const,
      payload: {
        source_message_id: "msg_01",
        accepted_fields: [
          { field: "name" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "Margaret Chen", evidence: "My name is Margaret Chen",
            normalized_value: "Margaret Chen", status: "explicit" as const },
          { field: "dob" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "1985-03-15", evidence: "DOB is 1985-03-15",
            normalized_value: "1985-03-15", status: "explicit" as const },
          { field: "ssn_last4" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "4472", evidence: "SSN last four is 4472",
            normalized_value: "4472", status: "explicit" as const },
        ],
        case_hints: { intent: "denial_question", case_type: "healthcare", reported_status: "denied", month: 1, year: null },
      },
    },
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "identity_verification_completed" as const,
      payload: {
        identity_revision: 1,
        field_versions: { name: 1, dob: 1, ssn_last4: 1 },
        status: "verified" as const,
        party_id: "P9",
        matched_fields: ["name", "dob", "ssn_last4"] as const,
      },
    },
  ];
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);
  assert.equal(state.phase, "RESOLVE_INTENT");
  assert.equal(state.party_id, "P9");
  assert.equal(facts.case_hints?.intent, "denial_question");
  assert.equal(facts.case_hints?.month, 1);
});

test("verification invalidated when field is corrected", () => {
  const events = [
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "user_information_recorded" as const,
      payload: {
        source_message_id: "msg_01",
        accepted_fields: [
          { field: "name" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "Margaret Chen", evidence: "My name is Margaret Chen",
            normalized_value: "Margaret Chen", status: "explicit" as const },
          { field: "dob" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "1985-03-15", evidence: "DOB is 1985-03-15",
            normalized_value: "1985-03-15", status: "explicit" as const },
          { field: "ssn_last4" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "4472", evidence: "SSN last four is 4472",
            normalized_value: "4472", status: "explicit" as const },
        ],
      },
    },
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "identity_verification_completed" as const,
      payload: {
        identity_revision: 1,
        field_versions: { name: 1, dob: 1, ssn_last4: 1 },
        status: "verified" as const,
        party_id: "P9",
        matched_fields: ["name", "dob", "ssn_last4"] as const,
      },
    },
    // User corrects SSN → verification must be invalidated.
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "user_information_recorded" as const,
      payload: {
        source_message_id: "msg_02",
        accepted_fields: [
          { field: "ssn_last4" as const, subject: "caller" as const, operation: "correct" as const,
            raw_value: "4473", evidence: "not 4472, it's 4473",
            normalized_value: "4473", status: "explicit" as const },
        ],
      },
    },
  ];
  const facts = reduceSessionEvents(events);
  const state = deriveSopState(facts);
  assert.equal(facts.identity.verification, null);
  assert.equal(state.phase, "VERIFY_ID");
});

test("late verification result for outdated revision is ignored", () => {
  const events = [
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "user_information_recorded" as const,
      payload: {
        source_message_id: "msg_01",
        accepted_fields: [
          { field: "name" as const, subject: "caller" as const, operation: "provide" as const,
            raw_value: "Margaret Chen", evidence: "Margaret Chen",
            normalized_value: "Margaret Chen", status: "explicit" as const },
        ],
      },
    },
    // Verification result arrives but targets revision 0, while identity is now revision 1.
    {
      event_id: makeEventId(), session_id: SESSION, seq: nextSeq(),
      timestamp: new Date().toISOString(), sop_version: SOP_VERSION,
      type: "identity_verification_completed" as const,
      payload: {
        identity_revision: 0,
        field_versions: {},
        status: "verified" as const,
        party_id: "P9",
        matched_fields: ["name"] as const,
      },
    },
  ];
  const facts = reduceSessionEvents(events);
  assert.equal(facts.identity.verification, null);
});
