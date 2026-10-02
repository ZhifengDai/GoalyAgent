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
  | "get_claim_details"
  | "get_claim_guidance"
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

  // POST_PROCESS: case has been handled; awaiting email decision.
  if (facts.case_resolution.status === "resolved" && facts.identity.verification) {
    const emailDecision = facts.customer_decisions.email_summary;
    if (emailDecision === "unknown" || emailDecision === "send") {
      return {
        phase: "POST_PROCESS",
        allowed_tools: ["record_customer_decision", "prepare_summary_email", "send_summary_email", "request_human_handoff"],
        missing_identity_fields: [],
        pending_clarification: [],
        party_id: facts.identity.verification.party_id,
        next_requirement: emailDecision === "send"
          ? "收件人和摘要已确认；发送邮件"
          : "询问用户是否发送摘要邮件",
      };
    }
  }

  // PROCESS_CASE: intent resolved, case selected, identity verified.
  if (
    facts.case_resolution.status === "resolved" &&
    facts.identity.verification
  ) {
    return {
      phase: "PROCESS_CASE",
      allowed_tools: ["get_claim_details", "get_claim_guidance", "record_customer_decision", "request_human_handoff"],
      missing_identity_fields: [],
      pending_clarification: [],
      party_id: facts.identity.verification.party_id,
      next_requirement: "解答案件问题",
    };
  }

  // RESOLVE_INTENT: identity verified, case not yet selected.
  if (facts.identity.verification) {
    return {
      phase: "RESOLVE_INTENT",
      allowed_tools: ["find_claims", "select_claim", "request_human_handoff"],
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
    allowed_tools: ["request_human_handoff"],
    missing_identity_fields: needed > 0
      ? ["name", "dob", "phone", "email", "ssn_last4"].filter(f => !collectedFields.includes(f))
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
