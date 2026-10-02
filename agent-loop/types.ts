export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Json;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls: ToolCall[];
  stopReason: "stop" | "tool_calls" | "length" | "error" | "aborted";
}

export interface ToolResult {
  content: string;
  data?: Json;
  isError?: boolean;
}

export interface ToolMessage extends ToolResult {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
}

export type Message =
  | { role: "user"; content: string }
  | AssistantMessage
  | ToolMessage;

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Json;
}

export interface Tool extends ToolDeclaration {
  // Required: validate actual arguments, not just the schema shown to the model.
  validate: (args: Json) => void;
  execute: (args: Json, signal?: AbortSignal) => Promise<ToolResult>;
}

export interface Context {
  systemPrompt: string;
  runtimeContext: Json;
  messages: Message[];
  tools: Tool[];
}

export interface ModelRequest {
  systemPrompt: string;
  runtimeContext: Json;
  messages: Message[];
  tools: ToolDeclaration[];
}

export type ModelFn = (
  request: ModelRequest,
  options: { signal?: AbortSignal; onTextDelta: (delta: string) => Promise<void> },
) => Promise<AssistantMessage>;

export type EndReason = "complete" | "stopped" | "budget" | "error" | "aborted";

export type Event =
  | { type: "agent_start" }
  | { type: "turn_start"; turn: number }
  | { type: "message_end"; message: Message }
  | { type: "text_delta"; delta: string }
  | { type: "tool_execution_start"; call: ToolCall }
  | { type: "tool_execution_end"; call: ToolCall; result: ToolMessage }
  | { type: "turn_end"; turn: number; message: AssistantMessage; toolResults: ToolMessage[] }
  | { type: "agent_end"; reason: EndReason; error?: string };

export interface LoopOptions {
  model: ModelFn;
  signal?: AbortSignal;
  maxTurns?: number;
  maxToolCalls?: number;
  emit?: (event: Event) => void | Promise<void>;
  // Runs before EVERY model request, including the first. Persisted facts live outside this loop.
  prepareRequest?: (context: Context, signal?: AbortSignal) => void | Promise<void>;
  beforeToolCall?: (
    call: ToolCall, context: Context, signal?: AbortSignal,
  ) => Promise<{ block: true; reason: string } | undefined>;
  // Persist/reduce results here. A hook failure stops the run; it is not a tool failure.
  afterToolCall?: (
    call: ToolCall, result: ToolMessage, context: Context, signal?: AbortSignal,
  ) => void | Promise<void>;
  finishTurn?: (
    context: Context, message: AssistantMessage, results: ToolMessage[],
  ) => "continue" | "end" | undefined | Promise<"continue" | "end" | undefined>;
}

export interface RunResult {
  context: Context;
  reason: EndReason;
  turns: number;
  toolCalls: number;
  error?: string;
}
