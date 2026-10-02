import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { appendEvent, getEvents, makeEventId, SOP_VERSION } from "../session/events.ts";
import type { IdentityField } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";

const require = createRequire(import.meta.url);
const POLICYHOLDERS: Policyholder[] = require(
  fileURLToPath(new URL("../fixtures/policyholders.json", import.meta.url))
);

interface Policyholder {
  party_id: string;
  name: string;
  name_aliases?: string[];
  policy_number: string;
  dob: string;
  id_type: string;
  id_last4: string;
  phone: string;
  phone_aliases?: string[];
  email: string;
  email_aliases?: string[];
}

export type VerifyIdentityResult =
  | { status: "verified"; party_id: string; matched_fields: IdentityField[] }
  | { status: "insufficient_information" }
  | { status: "no_match" }
  | { status: "ambiguous" }
  | { status: "conflict"; detail: string };

const MINIMUM_MATCHES = 3;

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeEmail(s: string): string {
  const [local, domain] = s.trim().split("@");
  return domain ? `${local}@${domain.toLowerCase()}` : s.trim().toLowerCase();
}

function normalizePhone(s: string): string {
  return s.replace(/[\s\-().]/g, "");
}

const MONTH_NAMES: Record<string, string> = {
  january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",
  july:"07",august:"08",september:"09",october:"10",november:"11",december:"12",
  jan:"01",feb:"02",mar:"03",apr:"04",jun:"06",jul:"07",
  aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
};

function normalizeDob(s: string): string {
  const t = s.trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // YYYY-M-D / YYYY.M.D / YYYY/M/D
  const yFirst = t.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (yFirst) return `${yFirst[1]}-${yFirst[2]!.padStart(2,"0")}-${yFirst[3]!.padStart(2,"0")}`;
  // M/D/YYYY or MM/DD/YYYY (US)
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]!.padStart(2,"0")}-${us[2]!.padStart(2,"0")}`;
  // "March 15, 1985" or "Mar 15 1985"
  const mdy = t.match(/^([a-zA-Z]+)\s+(\d{1,2})[,\s]+(\d{4})$/);
  if (mdy) { const m = MONTH_NAMES[mdy[1]!.toLowerCase()]; if (m) return `${mdy[3]}-${m}-${mdy[2]!.padStart(2,"0")}`; }
  // "15 March 1985" or "15 Mar 1985"
  const dmy = t.match(/^(\d{1,2})\s+([a-zA-Z]+)[,\s]+(\d{4})$/);
  if (dmy) { const m = MONTH_NAMES[dmy[2]!.toLowerCase()]; if (m) return `${dmy[3]}-${m}-${dmy[1]!.padStart(2,"0")}`; }
  return t; // fallback: pass through unchanged
}

// ── Per-field match ───────────────────────────────────────────────────────────

function matchField(field: IdentityField, provided: string, holder: Policyholder): boolean {
  switch (field) {
    case "name": {
      const norm = normalizeName(provided);
      const names = [holder.name, ...(holder.name_aliases ?? [])].map(normalizeName);
      return names.includes(norm);
    }
    case "dob":
      return normalizeDob(provided) === holder.dob;
    case "phone": {
      const norm = normalizePhone(provided);
      const phones = [holder.phone, ...(holder.phone_aliases ?? [])].map(normalizePhone);
      return phones.includes(norm);
    }
    case "email": {
      const norm = normalizeEmail(provided);
      const emails = [holder.email, ...(holder.email_aliases ?? [])].map(normalizeEmail);
      return emails.includes(norm);
    }
    case "ssn_last4":
      return holder.id_type === "ssn_last4" && provided === holder.id_last4;
    case "national_id_last4":
      return holder.id_type === "national_id_last4" && provided === holder.id_last4;
  }
}

// ── Core verification logic ───────────────────────────────────────────────────

function evaluateCandidate(
  provided: Partial<Record<IdentityField, string>>,
  holder: Policyholder
): { matched: IdentityField[]; mismatched: IdentityField[] } {
  const fields = Object.keys(provided) as IdentityField[];
  const matched: IdentityField[] = [];
  const mismatched: IdentityField[] = [];

  for (const field of fields) {
    const value = provided[field]!;
    if (matchField(field, value, holder)) {
      matched.push(field);
    } else {
      mismatched.push(field);
    }
  }
  return { matched, mismatched };
}

// ── Public tool function ──────────────────────────────────────────────────────

export function verifyIdentity(sessionId: string): VerifyIdentityResult {
  const events = getEvents(sessionId);
  const facts = reduceSessionEvents(events);
  const { provided_fields, identity_revision, pending_clarification } = facts.identity;

  // Fields blocked by pending clarification cannot be used.
  const usableFields: Partial<Record<IdentityField, string>> = {};
  for (const [field, fact] of Object.entries(provided_fields) as [IdentityField, { value: string }][]) {
    if (!pending_clarification.includes(field)) {
      usableFields[field] = fact.value;
    }
  }

  if (Object.keys(usableFields).length < MINIMUM_MATCHES) {
    appendVerificationFailed(sessionId, events.length, identity_revision, "insufficient_information");
    return { status: "insufficient_information" };
  }

  // Score every policyholder.
  const candidates = POLICYHOLDERS.map(holder => ({
    holder,
    ...evaluateCandidate(usableFields, holder),
  }));

  // A candidate qualifies if it has ≥3 matched fields and zero mismatched.
  const qualified = candidates.filter(
    c => c.matched.length >= MINIMUM_MATCHES && c.mismatched.length === 0
  );

  // Candidates with some match but also a mismatch → conflict.
  const conflicted = candidates.filter(
    c => c.matched.length >= 1 && c.mismatched.length > 0
  );

  if (qualified.length === 0 && conflicted.length > 0) {
    const detail = conflicted
      .map(c => `${c.holder.party_id}: matched ${c.matched.join(",")} but mismatch on ${c.mismatched.join(",")}`)
      .join("; ");
    appendVerificationFailed(sessionId, events.length, identity_revision, "conflict");
    return { status: "conflict", detail };
  }

  if (qualified.length === 0) {
    appendVerificationFailed(sessionId, events.length, identity_revision, "no_match");
    return { status: "no_match" };
  }

  if (qualified.length > 1) {
    appendVerificationFailed(sessionId, events.length, identity_revision, "ambiguous");
    return { status: "ambiguous" };
  }

  const winner = qualified[0]!;
  const fieldVersions: Partial<Record<IdentityField, number>> = {};
  for (const field of winner.matched) {
    const fact = facts.identity.provided_fields[field];
    if (fact) fieldVersions[field] = fact.version;
  }

  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq: getEvents(sessionId).length,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "identity_verification_completed",
    payload: {
      identity_revision,
      field_versions: fieldVersions,
      status: "verified",
      party_id: winner.holder.party_id,
      matched_fields: winner.matched,
    },
  });

  return { status: "verified", party_id: winner.holder.party_id, matched_fields: winner.matched };
}

function appendVerificationFailed(
  sessionId: string,
  seq: number,
  identity_revision: number,
  status: "insufficient_information" | "no_match" | "ambiguous" | "conflict"
): void {
  appendEvent({
    event_id: makeEventId(),
    session_id: sessionId,
    seq,
    timestamp: new Date().toISOString(),
    sop_version: SOP_VERSION,
    type: "identity_verification_failed",
    payload: { identity_revision, status, blocking_conflicts: [] },
  });
}
