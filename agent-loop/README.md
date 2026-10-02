# Pi-inspired Agent Loop

独立的学习实现，参考本地 Pi 的循环和 hook 分工，未直接复制上游代码，不兼容 Pi 的完整 API。无需 npm 依赖，使用 Node 24 的 TypeScript 类型擦除运行。

```bash
node agent-loop/demo.ts
node --test agent-loop/agent-loop.test.ts
```

文件：types.ts 定义消息、工具和接口；agent-loop.ts 调度主循环；demo.ts 使用模拟模型演示权限拒绝与成功工具回传；agent-loop.test.ts 验证行为边界。

## GPT-4.1 接口

`openai-model.ts` 提供 `createOpenAIModel()`，使用 OpenAI Chat Completions 和函数工具调用。它自动读取项目根目录的 `.env`。支持 `OPENAI_API_KEY`、`OPENAI_MODEL`（默认 `gpt-4.1`）及 `OPENAI_BASE_URL`（默认官方 `/v1` 地址）；显式进程环境变量和构造参数优先。创建适配器本身不会发请求；调用 `runAgentLoop()` 时才发送。它复用当前 Context 的 systemPrompt、runtimeContext、messages 和工具声明，每轮重放当前完整对话。工具执行和授权检查继续由 Loop 与 Harness 控制。

在项目根目录的 `.env` 中填入 `OPENAI_API_KEY`，按需修改模型名与 API 基地址，然后运行：

```bash
node agent-loop/openai-demo.ts "你好，请用一句话介绍自己"
```

在保险应用中，将 `createOpenAIModel()` 传给 `runAgentLoop` 的 `model`；通过 `prepareRequest` 恢复当前 SOP State，并在工具后端实现真实的身份和案件权限检查。不要把 API key 放入浏览器代码、日志或仓库文件。示例命令会产生真实 API 使用量；本项目未执行真实请求。

适配器以 `store: false` 发送请求，不依赖服务端保存会话。`parallel_tool_calls: false` 使单次模型响应最多选择一个工具；Loop 仍能处理多个工具调用。响应当前采用非流式模式，`text_delta` 事件在完整文本返回后发出一次；真实逐字流式传输尚未实现。适配器将 `finish_reason=length` 标记为截断，Loop 不执行该响应中的工具调用。提供 `fetchImpl` 用于本地无网络测试。

执行顺序：追加用户消息 → prepareRequest → 模型响应 → 参数校验 → beforeToolCall → 工具执行 → afterToolCall → 追加工具结果 → finishTurn → 下一次模型请求或结束。

prepareRequest 可恢复 Facts/State，并同时更新 runtimeContext 与 tools。模型只接收工具声明，不接收执行函数。工具按顺序运行；每次执行前检查权限，结果处理完成后才执行下一项。工具不可用、参数错误、被拒绝和执行失败成为错误工具结果；Harness hook 抛错则停止运行。

调用返回原 context（原地维护消息）及 reason、turns、toolCalls。新输入为字符串；传 undefined 可从 user/toolResult 尾部继续。reason 为 complete / stopped / budget / error / aborted。maxTurns 与 maxToolCalls 限制模型和工具调用；signal 采用协作取消，模型、工具和 hooks 必须响应 signal，无法强制终止忽略它的任务。

首次版本提供模型接口注入、可选文本增量事件、动态上下文及工具、工具验证和授权 hooks、显式继续/结束、截断工具调用拒绝、取消和预算。现已接入 GPT-4.1 的非流式模型适配。暂未实现并行工具、steering/follow-up、持久化恢复、幂等外部操作、身份提取或完整 SOP。

text_delta 和 message_end 是内部观察事件，不代表通过交付检查。保险 UI 应缓冲并检查后再显示。afterToolCall 接收失败/拒绝结果时不得将其写成成功事实；持久化失败必须阻止后续流程。此学习实现没有持久化事务，生产接入还需处理“操作成功但保存结果失败”的恢复。

参考源码：[Pi loop](../vendor/pi/packages/agent/src/agent-loop.ts)。业务设计：[第一阶段](../docs/phase-1-identity-verification.md)。
