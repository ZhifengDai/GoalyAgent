# 模块设计

本文记录保险客服 Agent 的实现模块划分，基于 [整体架构](agent-loop-architecture.md) 细化为可交付的代码结构。

## 目录结构

```
apps/insurance_claims/
│
├── session/          ← 记忆层（Events → Facts → State）
├── tools/            ← 业务工具层
├── prompts/          ← System Prompt + 提取 Prompt
├── harness/          ← 控制层（外层入口 + Hook 实现）
└── index.ts          ← 启动入口，串联所有模块
```

## 各模块职责

### `session/`（记忆层）

整个系统的事实数据库，是其他所有模块的数据来源。

```
events.ts    — 事件类型定义 + 持久化读写
facts.ts     — reduceSessionEvents()：事件 → Facts
state.ts     — deriveSopState()：Facts + SOP规则 → 当前阶段/权限
```

- 事件历史是唯一可信的持久化来源；Facts 和 State 每次从事件重算，不单独存储
- 写事件的权限只有工具后端和 Harness 有，用户输入和模型输出都不能直接写

### `tools/`（业务工具层）

LLM 可以调用的所有工具，每个工具后端自己做最终授权检查（不信任 Harness 已检查过）。

```
record-user-information.ts
verify-identity.ts
find-claims.ts
select-claim.ts
get-claim-details.ts
get-claim-guidance.ts
record-customer-decision.ts
prepare-summary-email.ts
send-summary-email.ts
request-human-handoff.ts
```

工具的可见集合（注册给模型的）和可执行集合（`beforeToolCall` 放行的）都由 `harness/guard.ts` 控制；工具后端仍然逐次检查身份有效性和资源归属。

### `prompts/`（Prompt 层）

两种 Prompt 职责完全不同，不能混用。

```
system-prompt.ts      — 固定 SOP 规则，从版本化 SOP 配置渲染，启动时解析一次
extraction-prompt.ts  — 受限提取 Prompt，禁止输出 phase/verified/party_id 等授权字段
context-builder.ts    — buildRuntimeContext()：Facts + State → 每次模型请求前注入的 JSON
```

Runtime Context 由后端构建注入，模型只能读不能写；提取 Prompt 的输出只能是候选结构，不产生验证结论。

### `harness/`（控制层）

系统的执行外壳，保证安全属性不依赖 LLM 行为。

```
handler.ts     — Outer Handler：每条用户消息的必经流程
guard.ts       — beforeToolCall：阶段/权限集中检查
persist.ts     — afterToolCall：工具结果持久化，触发 Facts 更新
turn-check.ts  — finishTurn：检查本轮是否合规
```

`handler.ts` 是每条用户消息的入口，在 `runAgentLoop` 之前强制执行：

```
extract_user_information(msg)   ← 独立提取 LLM，使用 extraction-prompt
apply_and_validate(candidates)  ← 后端 schema 检查，写事件
maybe_verify_identity()         ← 身份字段变化时触发，写核验结果事件
reduce_and_derive()             ← 归约 Facts，派生 State
build_context()                 ← 构建初始 runtimeContext 和工具集合
runAgentLoop(...)
```

## 模块间数据流

```
用户输入
  ↓
harness/handler.ts
  ├── prompts/extraction-prompt.ts  → 独立提取 LLM
  ├── session/events.ts             → 写入提取结果事件
  ├── tools/verify-identity.ts      → 比对 policyholders.json
  ├── session/facts.ts              → 归约 Facts
  ├── session/state.ts              → 派生 State
  └── prompts/context-builder.ts   → 构建 runtimeContext
      ↓
  runAgentLoop(context, {
    prepareRequest → context-builder.ts（每 turn 刷新）
    beforeToolCall → harness/guard.ts
    afterToolCall  → harness/persist.ts
    finishTurn     → harness/turn-check.ts
  })
      ↓
  tools/ 被调用（自带后端授权检查）
```

## 开发顺序

| 顺序 | 模块 | 原因 |
|------|------|------|
| 1 | `session/` | 其他所有模块都依赖它 |
| 2 | `tools/verify-identity` + `tools/find-claims` | VERIFY_ID 核心工具，可用 fixture 数据驱动测试 |
| 3 | `prompts/` | 固定规则 + 提取 Prompt + context-builder |
| 4 | `harness/handler` | 串联上面三层，跑通单条消息的完整链路 |
| 5 | 其余 tools | 覆盖 RESOLVE_INTENT / PROCESS_CASE / POST_PROCESS |
| 6 | `index.ts` + UI | 端到端跑通完整四阶段流程 |

每个阶段完成后用 Margaret Chen 测试用例验收，再推进下一阶段。
