import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "./agent-loop.ts";
import type { AssistantMessage, Context, Event, ModelFn, Tool } from "./types.ts";

const call = (id = "c1", args = {}): AssistantMessage => ({
  role: "assistant", content: "", toolCalls: [{ id, name: "lookup", arguments: args }], stopReason: "tool_calls",
});
const answer = (): AssistantMessage => ({ role: "assistant", content: "done", toolCalls: [], stopReason: "stop" });
const context = (tools: Tool[] = []): Context => ({
  systemPrompt: "rules", runtimeContext: {}, messages: [], tools,
});
const tool = (execute: Tool["execute"]): Tool => ({
  name: "lookup", description: "lookup", parameters: { type: "object" },
  validate: args => { if (args === null || typeof args !== "object") throw new Error("Invalid args"); },
  execute,
});

test("result is persisted before the next request; context and tools refresh each turn", async () => {
  let verified = false;
  let requests = 0;
  const events: Event[] = [];
  const ctx = context([tool(async () => ({ content: "evidence", data: { verified: true } }))]);
  const model: ModelFn = async request => {
    requests++;
    if (requests === 1) {
      assert.equal(request.tools.length, 1);
      assert.equal("execute" in request.tools[0], false);
      return call();
    }
    assert.deepEqual(request.runtimeContext, { verified: true });
    assert.deepEqual(request.tools, []);
    assert.equal(request.messages.at(-1)?.role, "toolResult");
    return answer();
  };
  const result = await runAgentLoop("hello", ctx, {
    model,
    prepareRequest: ctx => {
      ctx.runtimeContext = { verified };
      if (verified) ctx.tools = [];
    },
    afterToolCall: (_call, result) => { if (!result.isError) verified = true; },
    emit: event => { events.push(event); },
  });
  assert.equal(result.reason, "complete");
  assert.equal(result.turns, 2);
  assert.equal(events.at(-1)?.type, "agent_end");
});

test("blocked, invalid, unavailable and throwing tools return errors without unauthorized execution", async () => {
  for (const scenario of ["blocked", "invalid", "missing", "throwing"]) {
    let executions = 0;
    const ctx = context(scenario === "missing" ? [] : [tool(async () => {
      executions++;
      if (scenario === "throwing") throw new Error("service failed");
      return { content: "success" };
    })]);
    let requestCount = 0;
    const result = await runAgentLoop("hello", ctx, {
      model: async request => {
        if (++requestCount === 1) {
          const message = call();
          if (scenario === "invalid") message.toolCalls[0].arguments = "bad";
          return message;
        }
        const tail = request.messages.at(-1);
        assert.equal(tail?.role, "toolResult");
        if (tail?.role === "toolResult") assert.equal(tail.isError, true);
        return answer();
      },
      beforeToolCall: async () => scenario === "blocked" ? { block: true, reason: "not verified" } : undefined,
    });
    assert.equal(result.reason, "complete");
    assert.equal(executions, scenario === "throwing" ? 1 : 0);
  }
});

test("sequential guard sees the prior tool result in the same batch", async () => {
  let executions = 0;
  let deny = false;
  const ctx = context([tool(async () => { executions++; return { content: "ok" }; })]);
  let requests = 0;
  await runAgentLoop("hello", ctx, {
    model: async () => {
      if (++requests > 1) return answer();
      const message = call();
      message.toolCalls.push({ id: "c2", name: "lookup", arguments: {} });
      return message;
    },
    beforeToolCall: async () => deny ? { block: true, reason: "permission changed" } : undefined,
    afterToolCall: () => { deny = true; },
  });
  assert.equal(executions, 1);
});

test("turn and tool budgets stop runaway loops", async () => {
  for (const limitTools of [false, true]) {
    let sequence = 0;
    let executions = 0;
    const result = await runAgentLoop("hello", context([tool(async () => {
      executions++; return { content: "ok" };
    })]), {
      model: async () => call(`c${++sequence}`),
      maxTurns: 3,
      maxToolCalls: limitTools ? 1 : 10,
    });
    assert.equal(result.reason, "budget");
    assert.equal(executions, limitTools ? 1 : 3);
  }
});

test("truncated tool calls never execute", async () => {
  let executions = 0;
  let requests = 0;
  const result = await runAgentLoop("hello", context([tool(async () => {
    executions++; return { content: "ok" };
  })]), {
    model: async () => {
      if (++requests > 1) return answer();
      return { ...call(), stopReason: "length" };
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.reason, "complete");
});

test("hook persistence failure stops before another model request", async () => {
  let requests = 0;
  const result = await runAgentLoop("hello", context([tool(async () => ({ content: "ok" }))]), {
    model: async () => { requests++; return call(); },
    afterToolCall: () => { throw new Error("persistence unavailable"); },
  });
  assert.equal(result.reason, "error");
  assert.equal(requests, 1);
});

test("cancellation and provider failures produce a final lifecycle event", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    if (abort) controller.abort();
    const events: Event[] = [];
    const result = await runAgentLoop("hello", context(), {
      signal: controller.signal,
      model: async () => { throw new Error("provider unavailable"); },
      emit: event => { events.push(event); },
    });
    assert.equal(result.reason, abort ? "aborted" : "error");
    assert.equal(events.at(-1)?.type, "agent_end");
  }
});

test("explicit continuation is bounded, explicit end skips another request", async () => {
  const repeated = await runAgentLoop("hello", context(), {
    model: async () => answer(), finishTurn: () => "continue", maxTurns: 2,
  });
  assert.equal(repeated.reason, "budget");
  assert.equal(repeated.turns, 2);
  const stopped = await runAgentLoop("hello", context([tool(async () => ({ content: "ok" }))]), {
    model: async () => call(), finishTurn: () => "end",
  });
  assert.equal(stopped.reason, "stopped");
  assert.equal(stopped.turns, 1);
});

test("continuation rejects an assistant tail and resumes a user tail", async () => {
  await assert.rejects(runAgentLoop(undefined, context(), { model: async () => answer() }));
  const ctx = context();
  ctx.messages.push({ role: "user", content: "retry" });
  const result = await runAgentLoop(undefined, ctx, { model: async () => answer() });
  assert.equal(result.reason, "complete");
  assert.equal(ctx.messages.filter(m => m.role === "user").length, 1);
});
