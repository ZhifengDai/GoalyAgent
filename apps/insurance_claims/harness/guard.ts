import type { ToolCall, Context } from "../../../agent-loop/types.ts";
import { getEvents } from "../session/events.ts";
import { reduceSessionEvents } from "../session/facts.ts";
import { deriveSopState } from "../session/state.ts";
import type { AllowedTool } from "../session/state.ts";

/**
 * beforeToolCall hook — centralized authorization check before any tool executes.
 * Fails closed: if anything is uncertain, block.
 */
export async function guard(
  call: ToolCall,
  _context: Context,
  sessionId: string,
): Promise<{ block: true; reason: string } | undefined> {
  // verify_identity must never be called by the LLM.
  if (call.name === "verify_identity") {
    return { block: true, reason: "verify_identity is reserved for internal use" };
  }

  const events = getEvents(sessionId);
  const facts  = reduceSessionEvents(events);
  const state  = deriveSopState(facts);

  const allowed = state.allowed_tools as string[];
  if (!allowed.includes(call.name)) {
    return {
      block: true,
      reason: `Tool "${call.name}" is not available in phase ${state.phase}`,
    };
  }

  // Phase-specific extra checks.
  if (
    (call.name as AllowedTool) === "send_summary_email" &&
    facts.customer_decisions.email_summary !== "send"
  ) {
    return { block: true, reason: "send_summary_email requires explicit send consent" };
  }

  if (
    (call.name as AllowedTool) === "select_claim" &&
    !facts.identity.verification
  ) {
    return { block: true, reason: "select_claim requires verified identity" };
  }

  return undefined; // allow
}
