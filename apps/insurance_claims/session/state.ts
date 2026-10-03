import type { SessionFacts } from "./facts.ts";

export type SopPhase =
  | "VERIFY_ID"
  | "RESOLVE_INTENT"
  | "PROCESS_CASE"
  | "POST_PROCESS"
  | "DONE"
  | "HUMAN_HANDOFF";

export type AllowedTool =
  | "record_user_information"
  | "verify_identity"
  | "find_claims"
  | "select_claim"
  | "confirm_no_claims"
  | "get_claim_info"
  | "restart_claim_selection"
  | "record_customer_decision"
  | "prepare_summary_email"
  | "send_summary_email"
  | "request_human_handoff";

export interface SopState {
  phase: SopPhase;
  allowed_tools: AllowedTool[];
  // Fields still needed to satisfy VERIFY_ID.
  missing_identity_fields: string[];
  // Clarifications blocking verification.
  pending_clarification: string[];
  // party_id once verified; null before.
  party_id: string | null;
  // Unified requirement description for runtime context.
  next_requirement: string;
}

const MINIMUM_MATCHES = 3;

export function deriveSopState(facts: SessionFacts): SopState {
  // Terminal states first.
  if (facts.human_handoff) {
    return terminal("HUMAN_HANDOFF", facts);
  }
  if (facts.email_sent || facts.customer_decisions.email_summary === "skip") {
    return terminal("DONE", facts);
  }

  // POST_PROCESS: customer made an explicit email decision (send or skip).
  if (
    facts.case_resolution.status === "resolved" &&
    facts.identity.verification &&
    facts.customer_decisions.email_summary !== "unknown"
  ) {
    const emailDecision = facts.customer_decisions.email_summary;
    return {
      phase: "POST_PROCESS",
      allowed_tools: ["record_customer_decision", "prepare_summary_email", "send_summary_email", "request_human_handoff"],
      missing_identity_fields: [],
      pending_clarification: [],
      party_id: facts.identity.verification.party_id,
      next_requirement: emailDecision === "send"
        ? "收件人和摘要已确认；发送邮件"
        : "用户已选择跳过，结束流程",
    };
  }

  // PROCESS_CASE: case selected (or no claims), identity verified, email decision not yet made.
  if (
    facts.case_resolution.status === "resolved" &&
    facts.identity.verification
  ) {
    const tools: AllowedTool[] = facts.case_resolution.no_claims
      ? ["record_customer_decision", "request_human_handoff"]
      : ["get_claim_info", "restart_claim_selection", "record_customer_decision", "request_human_handoff"];
    return {
      phase: "PROCESS_CASE",
      allowed_tools: tools,
      missing_identity_fields: [],
      pending_clarification: [],
      party_id: facts.identity.verification.party_id,
      next_requirement: facts.case_resolution.no_claims
        ? "无案件，询问是否发送邮件"
        : "解答案件问题，完成后询问是否发送摘要邮件",
    };
  }

  // RESOLVE_INTENT: identity verified, case not yet selected.
  if (facts.identity.verification) {
    return {
      phase: "RESOLVE_INTENT",
      allowed_tools: ["find_claims", "select_claim", "confirm_no_claims", "request_human_handoff"],
      missing_identity_fields: [],
      pending_clarification: [],
      party_id: facts.identity.verification.party_id,
      next_requirement: "使用已记线索查询并确定目标案件",
    };
  }

  // VERIFY_ID: default until identity is verified.
  const collectedFields = Object.keys(facts.identity.provided_fields) as string[];
  const needed = MINIMUM_MATCHES - collectedFields.length;
  const pending = facts.identity.pending_clarification;

  return {
    phase: "VERIFY_ID",
    allowed_tools: ["record_user_information", "request_human_handoff"],
    missing_identity_fields: needed > 0
      ? ["name", "dob", "phone", "email", "ssn_last4", "national_id_last4"].filter(f => !collectedFields.includes(f))
      : [],
    pending_clarification: pending,
    party_id: null,
    next_requirement: pending.length > 0
      ? `澄清 ${pending.join(", ")} 后继续核验`
      : needed > 0
        ? `还需要 ${needed} 种身份字段`
        : "字段已足够，等待核验结果",
  };
}

function terminal(phase: "DONE" | "HUMAN_HANDOFF", facts: SessionFacts): SopState {
  return {
    phase,
    allowed_tools: [],
    missing_identity_fields: [],
    pending_clarification: [],
    party_id: facts.identity.verification?.party_id ?? null,
    next_requirement: phase === "DONE" ? "流程已结束" : "等待人工处理",
  };
}
