# Pi 本地源码学习与开发入口

## 本地基线

- 官方仓库：https://github.com/earendil-works/pi
- 本地完整克隆：`vendor/pi`，包含独立 Git 历史。
- 拉取基线：`9fba660cf1caca0ade5bea72269352416e595a19`。
- 基线中的包名与版本：`@earendil-works/pi-agent-core@1.0.0`、`@earendil-works/pi-ai@1.0.0`。这是源码 package.json 声明，不表示本地已经安装或构建。
- Node 要求：`>=22.19.0`；当前本地为 `v24.15.0`。
- 当前完成源码克隆和导航，未安装依赖、运行构建或执行测试。

这是 monorepo，Agent Core 不单独克隆；它与模型层、遥测层及其他包共用仓库。业务代码继续位于项目外层的 `apps/insurance_claims`，便于区分上游源码和保险 Harness。

## 阅读顺序

| 顺序 | 本地文件 | 学习重点 |
|---|---|---|
| 1 | [Agent README](../vendor/pi/packages/agent/README.md) | Agent 使用方式与生命周期 |
| 2 | [types.ts](../vendor/pi/packages/agent/src/types.ts) | Context、Tool、Event 与 hooks 的契约 |
| 3 | [agent.ts](../vendor/pi/packages/agent/src/agent.ts) | 状态封装、prompt、事件、队列、取消 |
| 4 | [agent-loop.ts](../vendor/pi/packages/agent/src/agent-loop.ts) | 主循环、模型请求、工具执行和继续条件 |
| 5 | [agent-loop.test.ts](../vendor/pi/packages/agent/test/agent-loop.test.ts) | 用模拟响应观察和验证循环行为 |
| 6 | [agent.test.ts](../vendor/pi/packages/agent/test/agent.test.ts) | Agent 层状态和控制行为 |
| 7 | [AI README](../vendor/pi/packages/ai/README.md) | 模型提供商、消息与流式接口 |

先理解单次 prompt 为什么可能包含多次模型请求，再理解多个工具调用、失败、取消及 queued input。框架 turn 是模型响应及工具处理单位，不是 SOP 阶段。

## 主循环观察位置

在 agent-loop.ts 中按函数阅读：

1. `runAgentLoop` / `runAgentLoopContinue`：进入循环。
2. `runLoop`：调度模型请求、工具结果、steering 和 follow-up。
3. `streamAssistantResponse`：消息转换和流式模型响应。
4. `prepareToolCall`：参数检查及 beforeToolCall。
5. `executeToolCallsSequential` / `executeToolCallsParallel`：执行模式。
6. `finalizeExecutedToolCall`：结果后处理及 afterToolCall。

当前主循环在工具结果后允许继续请求模型；没有工具、队列或显式继续要求时结束。错误和取消响应直接结束本次运行。工具批次终止、finishTurn 决策等细节以当前源码和测试为准。

## 保险 Harness 接入建议

| 业务操作 | 放置位置 |
|---|---|
| 每条用户消息的信息提取、记录和必要身份核验 | 调用 agent.prompt 之前的应用入口；不能依赖模型自主选择 |
| 从事件恢复 Facts 与 State | 后端确定性模块 |
| 首次及后续模型请求的授权上下文 | prepareRequest；每次检查最新状态 |
| 后续 turn 的工具集合与上下文更新 | prepareNextTurnWithContext / prepareNextTurn；首次请求前先设置初始工具集合 |
| 执行动作的集中权限检查 | beforeToolCall |
| 工具结果持久化和 Facts 更新 | 工具服务层或 afterToolCall；选择一个明确的持久化责任方，防止重复记录 |
| 调用预算、是否结束或继续 | finishTurn 及应用级超时/取消控制 |
| UI 与可观察性 | subscribe；受保护输出需在交付前缓冲检查 |

工具可见集合与工具执行权限都需要控制。prepareRequest 不应被误当成自动管理所有持久化与工具声明的机制；接入时要验证 transcript 中声明的工具与实际可执行集合一致。后端工具自身仍逐次检查授权与资源归属。

业务设计参见 [第一阶段设计](phase-1-identity-verification.md)。优先用现有 hooks 实现 Harness；需要改变循环调度时再修改核心源码，并补对应行为测试。

## 运行准备

在 `vendor/pi` 中开发前遵循 [AGENTS.md](../vendor/pi/AGENTS.md)。安装依赖使用：

```bash
cd vendor/pi
npm ci --ignore-scripts
```

首次学习可优先运行 Agent Loop 的模拟测试，不需要配置真实模型 key，也不需要先调用付费模型：

```bash
cd packages/agent
node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts
```

以上是后续准备命令，本次未执行。若源码测试依赖缺失的数据或产物，应按实际失败及仓库指引补齐，不假定 clone 后即能运行。

修改 Pi 核心代码后按仓库要求运行 `npm run check`；新增或修改的测试需单独运行。不默认运行完整测试套件或构建。开发前建议建立本地工作分支，保留上述提交作为对照；不自动推送到 origin。
