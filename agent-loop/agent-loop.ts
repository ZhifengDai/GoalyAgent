import type {
  AssistantMessage, Context, EndReason, LoopOptions, Message, RunResult, ToolMessage,
} from "./types.ts";

/** Pi-inspired educational loop; independent implementation, not a drop-in Pi API. */
export async function runAgentLoop(
  input: string | undefined,
  context: Context,
  options: LoopOptions,
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? 8;
  const maxToolCalls = options.maxToolCalls ?? 16;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 ||
      !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new Error("Invalid loop budget");
  }
  if (input === undefined && context.messages.at(-1)?.role !== "user" &&
      context.messages.at(-1)?.role !== "toolResult") {
    throw new Error("Continuation requires a user or toolResult tail");
  }

  const emit = options.emit ?? (() => {});
  let turns = 0;
  let toolCalls = 0;
  let toolBudgetExhausted = false;
  let reason: EndReason = "budget";
  let error: string | undefined;
  const callIds = new Set(context.messages.filter(m => m.role === "assistant")
    .flatMap(m => m.toolCalls.map(call => call.id)));

  const append = async (message: Message) => {
    context.messages.push(message);
    await emit({ type: "message_end", message });
  };

  await emit({ type: "agent_start" });
  try {
    options.signal?.throwIfAborted();
    if (input !== undefined) await append({ role: "user", content: input });

    while (turns < maxTurns) {
      options.signal?.throwIfAborted();
      await options.prepareRequest?.(context, options.signal);
      options.signal?.throwIfAborted();
      const names = context.tools.map(tool => tool.name);
      if (new Set(names).size !== names.length) throw new Error("Duplicate tool names");
      turns++;
      await emit({ type: "turn_start", turn: turns });
      // Snapshot only model-visible data; executable functions never enter the request.
      const request = structuredClone({
        systemPrompt: context.systemPrompt,
        runtimeContext: context.runtimeContext,
        messages: context.messages,
        tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      });
      const message: AssistantMessage = await options.model(request, {
        signal: options.signal,
        onTextDelta: async delta => {
          options.signal?.throwIfAborted();
          await emit({ type: "text_delta", delta });
        },
      });
      options.signal?.throwIfAborted();
      await append(message);
      const results: ToolMessage[] = [];

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        reason = message.stopReason;
        await emit({ type: "turn_end", turn: turns, message, toolResults: results });
        break;
      }

      // Sequential execution allows a guard to observe facts from the previous call.
      for (const call of message.toolCalls) {
        options.signal?.throwIfAborted();
        await emit({ type: "tool_execution_start", call });
        const result: ToolMessage = {
          role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: "", isError: false,
        };
        const tool = context.tools.find(candidate => candidate.name === call.name);
        if (!call.id || callIds.has(call.id)) {
          throw new Error("Missing or reused tool call ID");
        }
        callIds.add(call.id);

        if (toolCalls >= maxToolCalls) {
          result.content = "Tool call budget exhausted";
          result.isError = true;
          reason = "budget";
          toolBudgetExhausted = true;
        } else {
          toolCalls++;
          try {
            if (message.stopReason === "length") throw new Error("Truncated response: tool not executed");
            if (!tool) throw new Error("Tool unavailable");
            tool.validate(call.arguments);
          } catch (failure) {
            result.content = failure instanceof Error ? failure.message : "Invalid tool arguments";
            result.isError = true;
          }
          if (!result.isError && tool) {
            // Guard failures fail closed; do not convert them into an ordinary tool error.
            const decision = await options.beforeToolCall?.(call, context, options.signal);
            options.signal?.throwIfAborted();
            if (decision?.block) {
              result.content = decision.reason;
              result.isError = true;
            } else {
              try {
                Object.assign(result, await tool.execute(call.arguments, options.signal));
              } catch (failure) {
                if (options.signal?.aborted) throw failure;
                result.content = failure instanceof Error ? failure.message : "Tool execution failed";
                result.isError = true;
              }
            }
          }
        }
        // Finish recording an executed operation even if cancellation arrived during execution.
        await options.afterToolCall?.(call, result, context, options.signal);
        results.push(result);
        await append(result);
        await emit({ type: "tool_execution_end", call, result });
      }

      const decision = await options.finishTurn?.(context, message, results);
      await emit({ type: "turn_end", turn: turns, message, toolResults: results });
      options.signal?.throwIfAborted();
      if (toolBudgetExhausted) break;
      if (decision === "end") { reason = "stopped"; break; }
      if (message.stopReason === "length") {
        if (results.length > 0) continue;
        throw new Error("Truncated text response");
      }
      if (results.length === 0 && decision !== "continue") { reason = "complete"; break; }
    }
  } catch (failure) {
    reason = options.signal?.aborted ? "aborted" : "error";
    error = failure instanceof Error ? failure.message : "Agent loop failed";
  }
  await emit({ type: "agent_end", reason, error });
  return { context, reason, turns, toolCalls, error };
}
