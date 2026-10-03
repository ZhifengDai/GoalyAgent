import { loadProjectEnv, resolveOpenAIBaseUrl } from "./config.ts";
import type { AssistantMessage, Json, Message, ModelFn, ModelRequest, ToolCall } from "./types.ts";

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system" | "developer" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAIModelOptions {
  /** Defaults to OPENAI_API_KEY. Resolved when each request is sent. */
  apiKey?: string | (() => string | undefined);
  /** Defaults to gpt-4.1. */
  model?: string;
  /** Defaults to OPENAI_BASE_URL, then https://api.openai.com/v1. */
  baseUrl?: string;
  /** Injectable for local tests. */
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getApiKey(source: OpenAIModelOptions["apiKey"]): string {
  const raw = typeof source === "function" ? source() : source ?? process.env.OPENAI_API_KEY;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("OPENAI_API_KEY is required");
  }
  return raw.trim();
}

function toChatMessages(request: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: request.systemPrompt },
    { role: "developer", content: `Current runtime context (server supplied):\n${JSON.stringify(request.runtimeContext)}` },
  ];
  for (const item of request.messages) {
    if (item.role === "user") {
      messages.push({ role: "user", content: item.content });
    } else if (item.role === "assistant") {
      messages.push({
        role: "assistant", content: item.content || null,
        ...(item.toolCalls.length ? {
          tool_calls: item.toolCalls.map(call => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        } : {}),
      });
    } else {
      messages.push({
        role: "tool", tool_call_id: item.toolCallId,
        content: JSON.stringify({ content: item.content, data: item.data ?? null, isError: item.isError ?? false }),
      });
    }
  }
  return messages;
}

function parseToolCall(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.function) ||
      typeof value.function.name !== "string" || typeof value.function.arguments !== "string") {
    throw new Error("Malformed tool call in model response");
  }
  let args: Json;
  try {
    args = JSON.parse(value.function.arguments) as Json;
  } catch {
    // The loop's tool.validate rejects this, then reports a tool error to the model.
    args = value.function.arguments;
  }
  return { id: value.id, name: value.function.name, arguments: args };
}

function parseResponse(value: unknown): AssistantMessage {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new Error("Malformed OpenAI response: no choices");
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("Malformed OpenAI response: no assistant message");
  }
  const rawMessage = choice.message;
  if (rawMessage.content !== null && rawMessage.content !== undefined && typeof rawMessage.content !== "string") {
    throw new Error("Unsupported assistant content type");
  }
  if (rawMessage.tool_calls !== undefined && !Array.isArray(rawMessage.tool_calls)) {
    throw new Error("Malformed OpenAI response: tool calls");
  }
  const toolCalls = (rawMessage.tool_calls ?? []).map(parseToolCall);
  const content = typeof rawMessage.content === "string" ? rawMessage.content : "";
  switch (choice.finish_reason) {
    case "stop":
      if (toolCalls.length) throw new Error("Unexpected tool calls in stopped response");
      return { role: "assistant", content, toolCalls, stopReason: "stop" };
    case "tool_calls":
      if (!toolCalls.length) throw new Error("Tool-call finish without tool calls");
      return { role: "assistant", content, toolCalls, stopReason: "tool_calls" };
    case "length":
      return { role: "assistant", content, toolCalls, stopReason: "length" };
    case "content_filter":
      throw new Error("Model output blocked by content filter");
    default:
      throw new Error(`Unsupported model finish reason: ${String(choice.finish_reason)}`);
  }
}

/** Adapter for GPT-4.1 through OpenAI Chat Completions. Stateless transcript replay. */
export function createOpenAIModel(options: OpenAIModelOptions = {}): ModelFn {
  loadProjectEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = (options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1").trim();
  if (!model) throw new Error("OPENAI_MODEL cannot be empty");
  const endpoint = `${resolveOpenAIBaseUrl(options.baseUrl ?? process.env.OPENAI_BASE_URL)}/chat/completions`;
  return async (request, { signal, onTextDelta }) => {
    const tools = request.tools.map(tool => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      },
    }));
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey(options.apiKey)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: toChatMessages(request),
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        parallel_tool_calls: false,
        stream: false,
        store: false,
      }),
      signal: combinedSignal,
    });
    if (!response.ok) {
      // API response bodies can contain sensitive request fragments. Keep errors concise.
      throw new Error(`OpenAI request failed (HTTP ${response.status})`);
    }
    const result = parseResponse(await response.json());
    if (result.content) await onTextDelta(result.content);
    return result;
  };
}

export type { ModelRequest, Message };
