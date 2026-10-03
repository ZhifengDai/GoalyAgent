import type { Tool, ToolResult } from "../../../agent-loop/types.ts";
import type { SopState, AllowedTool } from "../session/state.ts";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { verifyIdentity } from "./verify-identity.ts";
import { findClaims } from "./find-claims.ts";
import { selectClaim } from "./select-claim.ts";
import { getClaimInfo } from "./get-claim-info.ts";
import { confirmNoClaims } from "./confirm-no-claims.ts";
import { recordCustomerDecision } from "./record-customer-decision.ts";
import { restartClaimSelection } from "./restart-claim-selection.ts";
import { prepareSummaryEmail, sendSummaryEmail } from "./send-summary-email.ts";
import { requestHumanHandoff } from "./request-human-handoff.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data, null, 2), isError: false };
}

function err(message: string): ToolResult {
  return { content: message, isError: true };
}

function requireString(args: unknown, key: string): string {
  if (
    args === null || typeof args !== "object" || Array.isArray(args) ||
    typeof (args as Record<string, unknown>)[key] !== "string"
  ) throw new Error(`Missing required string: ${key}`);
  return (args as Record<string, string>)[key]!;
}

function optionalString(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function optionalNumber(args: unknown, key: string): number | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

function makeRecordUserInformation(sessionId: string): Tool {
  return {
    name: "record_user_information",
    description:
      "Record identity fields, case hints, or caller role provided by the user in this turn. " +
      "Call this whenever the user provides a new or corrected identity field, " +
      "states their intent, or mentions a case type or status. " +
      "Do not call it with fabricated or inferred values.",
    parameters: {
      type: "object",
      properties: {
        accepted_fields: {
          type: "array",
          description: "Identity field observations extracted from the user message.",
          items: {
            type: "object",
            properties: {
              field:            { type: "string", enum: ["name","dob","phone","email","ssn_last4","national_id_last4"] },
              subject:          { type: "string", enum: ["caller","policyholder","other","unknown"] },
              operation:        { type: "string", enum: ["provide","correct","withdraw"] },
              raw_value:        { type: "string" },
              evidence:         { type: "string" },
              normalized_value: { type: "string" },
              status:           { type: "string", enum: ["explicit","ambiguous"] },
            },
            required: ["field","subject","operation","raw_value","evidence","normalized_value","status"],
          },
        },
        policy_number: { type: "string" },
        caller_role:   { type: "string", enum: ["policyholder","representative"] },
        case_hints: {
          type: "object",
          properties: {
            intent:          { type: "string" },
            case_type:       { type: "string" },
            reported_status: { type: "string" },
            month:           { type: "number" },
            year:            { type: ["number","null"] },
          },
        },
      },
      required: ["accepted_fields"],
    },
    validate(args) {
      if (args === null || typeof args !== "object" || Array.isArray(args))
        throw new Error("Arguments must be an object");
      const a = args as Record<string, unknown>;
      if (!Array.isArray(a["accepted_fields"]))
        throw new Error("accepted_fields must be an array");
    },
    async execute(args): Promise<ToolResult> {
      // record_user_information is handled by the Harness extraction pipeline
      // before runAgentLoop. The LLM calling it here is a secondary path for
      // fields it notices during the conversation that extraction may have missed.
      const a = args as Record<string, unknown>;
      const { appendEvent, makeEventId, SOP_VERSION } = await import("../session/events.ts");
      const events = getEvents(sessionId);
      appendEvent({
        event_id: makeEventId(),
        session_id: sessionId,
        seq: events.length,
        timestamp: new Date().toISOString(),
        sop_version: SOP_VERSION,
        type: "user_information_recorded",
        payload: {
          source_message_id: "",
          accepted_fields: (a["accepted_fields"] as []) ?? [],
          policy_number: typeof a["policy_number"] === "string" ? a["policy_number"] : undefined,
          caller_role: a["caller_role"] as "policyholder" | "representative" | undefined,
          case_hints: a["case_hints"] as object | undefined,
        },
      });
      return ok({ status: "recorded" });
    },
  };
}

function makeFindClaims(sessionId: string): Tool {
  return {
    name: "find_claims",
    description:
      "Search for claims belonging to the verified caller. " +
      "Use remembered case hints (case_type, month, year, reported_status) to narrow results. " +
      "Returns a list of matching claim summaries without sensitive financial details.",
    parameters: {
      type: "object",
      properties: {
        case_type:       { type: "string", enum: ["healthcare","dental","auto"] },
        month:           { type: "number", description: "Month number 1-12" },
        year:            { type: "number" },
        reported_status: { type: "string", enum: ["denied","open","closed"] },
      },
    },
    validate(args) {
      if (args !== null && typeof args !== "object") throw new Error("Arguments must be an object");
    },
    async execute(args): Promise<ToolResult> {
      const a = args as Record<string, unknown> | null ?? {};
      const result = findClaims(sessionId, {
        case_type:       optionalString(a, "case_type"),
        month:           optionalNumber(a, "month"),
        year:            optionalNumber(a, "year"),
        reported_status: optionalString(a, "reported_status"),
      });
      if (result.status === "not_authorized") return err("Not authorized: identity not verified");
      if (result.status === "no_claims")      return ok({ status: "no_claims", claims: [] });
      return ok(result);
    },
  };
}

function makeSelectClaim(sessionId: string): Tool {
  return {
    name: "select_claim",
    description:
      "Confirm a specific claim as the target for this session. " +
      "Call this once the correct claim has been identified from find_claims results. " +
      "Provide a brief selection_basis explaining why this claim was chosen.",
    parameters: {
      type: "object",
      properties: {
        case_id:         { type: "string", description: "The claim ID, e.g. CL-2048" },
        selection_basis: { type: "string", description: "Why this claim was selected" },
      },
      required: ["case_id","selection_basis"],
    },
    validate(args) {
      requireString(args, "case_id");
      requireString(args, "selection_basis");
    },
    async execute(args): Promise<ToolResult> {
      const caseId = requireString(args, "case_id");
      const basis  = requireString(args, "selection_basis");
      const result = selectClaim(sessionId, caseId, basis);
      if (result.status === "not_authorized") return err("Not authorized: identity not verified");
      if (result.status === "not_found")      return err(`Claim ${caseId} not found`);
      if (result.status === "wrong_owner")    return err(`Claim ${caseId} does not belong to the verified caller`);
      return ok(result);
    },
  };
}

function makeGetClaimInfo(sessionId: string, nowIso: string): Tool {
  return {
    name: "get_claim_info",
    description:
      "Retrieve full claim information: status, denial reason, missing documents, " +
      "appeal deadline with deadline_status (upcoming/passed/none), financial amounts, " +
      "and document submission guidance. " +
      "Call this first whenever the caller asks about their claim. " +
      "Always use deadline_status from this result — never infer it yourself.",
    parameters: { type: "object", properties: {} },
    validate() {},
    async execute(): Promise<ToolResult> {
      const result = getClaimInfo(sessionId, nowIso);
      if (result.status === "not_authorized")  return err("Not authorized");
      if (result.status === "no_case_selected") return err("No claim selected yet");
      return ok(result.info);
    },
  };
}

function makeConfirmNoClaims(sessionId: string): Tool {
  return {
    name: "confirm_no_claims",
    description:
      "Confirm that no claims were found for the verified caller. " +
      "Call this when find_claims returns no results so the session can " +
      "proceed to offer an email summary and close gracefully.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief description, e.g. 'No claims found for this account'" },
      },
      required: ["reason"],
    },
    validate(args) { requireString(args, "reason"); },
    async execute(args): Promise<ToolResult> {
      const reason = requireString(args, "reason");
      const result = confirmNoClaims(sessionId, reason);
      if (result.status === "not_authorized") return err("Not authorized: only available in RESOLVE_INTENT");
      return ok(result);
    },
  };
}

function makeRestartClaimSelection(sessionId: string): Tool {
  return {
    name: "restart_claim_selection",
    description:
      "Reset the current claim selection and return to claim search. " +
      "Use when the caller wants to discuss a different claim in the same session. " +
      "Previously discussed claims are remembered and will be included in the email summary.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the caller wants to switch claims" },
      },
      required: ["reason"],
    },
    validate(args) { requireString(args, "reason"); },
    async execute(args): Promise<ToolResult> {
      const reason = requireString(args, "reason");
      const result = restartClaimSelection(sessionId, reason);
      if (result.status === "not_authorized") return err("Not authorized: only available in PROCESS_CASE");
      return ok(result);
    },
  };
}

function makeRecordCustomerDecision(sessionId: string): Tool {
  return {
    name: "record_customer_decision",
    description:
      "Record the caller's decision about the post-case email summary. " +
      "Use 'send' only when the caller clearly and explicitly agrees to receive the email. " +
      "Use 'skip' when the caller declines. " +
      "Use 'unknown' only when the response is genuinely ambiguous — then ask again.",
    parameters: {
      type: "object",
      properties: {
        decision:        { type: "string", enum: ["send","skip","unknown"] },
        recipient_email: { type: "string", description: "Required when decision is 'send'" },
      },
      required: ["decision"],
    },
    validate(args) {
      requireString(args, "decision");
    },
    async execute(args): Promise<ToolResult> {
      const decision = requireString(args, "decision") as "send"|"skip"|"unknown";
      const email    = optionalString(args, "recipient_email");
      const result   = recordCustomerDecision(sessionId, decision, email);
      if (result.status === "not_authorized") return err("Not authorized in current phase");
      if (result.status === "ambiguous")      return err(result.reason);
      return ok({ status: "recorded", decision });
    },
  };
}

function makePrepareSummaryEmail(sessionId: string): Tool {
  return {
    name: "prepare_summary_email",
    description:
      "Generate a draft summary email for the caller's review before sending. " +
      "Shows subject and body without sending. " +
      "Requires explicit send consent already recorded.",
    parameters: { type: "object", properties: {} },
    validate() {},
    async execute(): Promise<ToolResult> {
      const result = prepareSummaryEmail(sessionId);
      if (result.status === "not_authorized") return err("Not authorized");
      if (result.status === "no_consent")     return err("No send consent recorded");
      return ok(result.draft);
    },
  };
}

function makeSendSummaryEmail(sessionId: string): Tool {
  return {
    name: "send_summary_email",
    description:
      "Send the summary email to the caller. " +
      "Only call this after the caller has given clear explicit consent and a recipient email is confirmed. " +
      "Do not claim the email was sent until this tool returns a successful send_id.",
    parameters: { type: "object", properties: {} },
    validate() {},
    async execute(): Promise<ToolResult> {
      const result = await sendSummaryEmail(sessionId);
      if (result.status === "not_authorized") return err("Not authorized");
      if (result.status === "no_consent")     return err("No send consent recorded");
      if (result.status === "failed")         return err(`Send failed: ${result.reason}`);
      return ok({ status: "sent", send_id: result.send_id });
    },
  };
}

function makeRequestHumanHandoff(sessionId: string): Tool {
  return {
    name: "request_human_handoff",
    description:
      "Create a human handoff request. " +
      "Use ONLY when: (1) the caller explicitly asks to speak with a human agent, OR " +
      "(2) all five identity field options (name, dob, phone, email, ssn_last4) have been " +
      "tried and none produced a verified match, OR (3) the issue is outside claim data scope. " +
      "Do NOT use this because fields seem insufficient — collect the missing fields first. " +
      "A request being created is not the same as a human being on the line.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why human handoff is needed" },
      },
      required: ["reason"],
    },
    validate(args) {
      requireString(args, "reason");
    },
    async execute(args): Promise<ToolResult> {
      const reason = requireString(args, "reason");
      const result = requestHumanHandoff(sessionId, reason);
      return ok(result);
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

const ALL_TOOL_MAKERS: Record<AllowedTool, (sessionId: string, nowIso: string) => Tool> = {
  record_user_information: (s)        => makeRecordUserInformation(s),
  verify_identity:         ()         => { throw new Error("verify_identity is Harness-only"); },
  find_claims:             (s)        => makeFindClaims(s),
  select_claim:            (s)        => makeSelectClaim(s),
  confirm_no_claims:       (s)        => makeConfirmNoClaims(s),
  get_claim_info:          (s, now)   => makeGetClaimInfo(s, now),
  restart_claim_selection: (s)        => makeRestartClaimSelection(s),
  record_customer_decision:(s)        => makeRecordCustomerDecision(s),
  prepare_summary_email:   (s)        => makePrepareSummaryEmail(s),
  send_summary_email:      (s)        => makeSendSummaryEmail(s),
  request_human_handoff:   (s)        => makeRequestHumanHandoff(s),
};

/** Return the Tool objects the conversation LLM is allowed to call right now. */
export function getAllowedTools(state: SopState, sessionId: string, nowIso: string): Tool[] {
  return state.allowed_tools
    .filter(name => name !== "verify_identity")
    .map(name => ALL_TOOL_MAKERS[name](sessionId, nowIso));
}
