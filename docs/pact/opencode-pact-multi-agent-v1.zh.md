# OpenCode PACT 多代理 v1

## 决策

PACT 多代理 v1 保留现有由 driver 持有的轮次事务。driver 仍然只启动一个 `pact-worker`；该 worker 可以保持单代理，也可以自主使用有界的只读专家。如果发生委派，同一个 worker 充当协调者，并且仍然是规范工作区与轮次摘要的唯一写入者。

多代理执行是 worker 的可选能力，而不是新的 PACT 阶段。现有 `implementation`、`full_alignment`、`review`、`finalize` 状态机保持不变。

## 配置

PACT 插件接受：

```json
{
  "multiAgentPolicy": "disabled",
  "multiAgentAllowedAgents": ["pact-specialist"],
  "multiAgentMaxSubagents": 3
}
```

- `multiAgentPolicy="disabled"` 是兼容性默认值。激活中的 PACT worker 不能调用 `task`。
- `multiAgentPolicy="auto"` 允许 worker 自行判断委派是否有价值。
- `multiAgentAllowedAgents` 是严格白名单。默认仅包含 `pact-specialist`。
- `multiAgentMaxSubagents` 限制每轮可尝试的委派次数。默认值为 3。

v1 有意不提供 `required` 策略。PACT 不会在直接执行更便宜或更安全时，因形式化委派而给予额外收益。

## 执行契约

在 `auto` 模式下：

1. driver 启动常规 `pact-worker`。
2. worker 判断当前目标是否受益于独立调查。
3. 被委派任务必须以前台方式执行，并使用允许的专家。
4. worker 等待专家结果，验证其内容，并整合任何有用发现。
5. 仅 worker 可修改规范工作区、做出实现决策，并写入 `round-NN-summary.md`。
6. worker 进程退出仍然是 CLI/LoLBench 的轮次边界。
7. driver 按照既有流程捕获规范补丁、验证补丁、调用 reviewer、推进台账并写入检查点。

```text
PACT driver 启动本轮 worker
          ↓
worker 自主判断
   ├─ 不使用子 Agent → 完全沿用当前 PACT 工作流
   └─ 使用子 Agent   → worker 作为 coordinator 调度子 Agent
          ↓
worker 完成最终修改并写 round summary
          ↓
PACT driver 捕获 patch、验证、review、checkpoint
```

v1 的限制是刻意设计的：

- 专家为只读；
- 专家会话中禁用 shell 与文件写入工具；
- 禁止后台委派；
- 禁止恢复既有专家 `task_id`；
- 禁止嵌套委派；
- 仅 reviewer 可用的 PACT 工件限制与基准网络限制继续生效；
- 专家不会更新 plan、todo、goal tracker、state、review 或 checkpoint 文件。

仓库定义了 `.opencode/agent/pact-specialist.md`。LoLBench smoke 配置也会注入同一份代理定义，这样基准工作区不依赖仓库本地代理发现。

## 可观测性

只有当 worker 进行了允许的委派后，PACT 才会写入 `round-NN-execution.json`。该文件缺失即表示该轮使用了传统单 worker 路径。

v1 工件记录：

- 策略与协调器模式；
- 只读工作区契约；
- 前台与禁止嵌套约束；
- task 调用 ID、专家名称、描述、可观测到的子会话 ID、以及状态。

常规工具事件仍写入 `round-NN-events.jsonl`。执行工件用于溯源；最终工作区补丁与经评审检查点仍是权威依据。

## 恢复兼容性

Round00 恢复流程不变。它会恢复规范规划工件，创建新循环，并从第 1 轮开始。不继承任何 worker 或专家会话。

精确轮次恢复也不变：

1. 校验现有轮次检查点与哈希文件；
2. 要求相同 Git 基线提交；
3. 应用并校验累计的规范工作区补丁；
4. 恢复评审后 plan、todo、goal-tracker 台账；
5. 清理历史活动 worker 会话；
6. 从第 `N+1` 轮启动新的 worker。

当 `round-NN-execution.json` 存在时，它会随继承轮次工件一起复制，但不会被重放，也不会恢复旧专家会话。恢复后的 worker 会独立决定新一轮是否需要专家。

这保证了与现有检查点模式 `pact-round-checkpoint/v2` 的兼容性：旧检查点没有多代理工件，仍然表示单 worker 执行。多代理 v1 不承诺轮次中途崩溃恢复。若在评审检查点之前崩溃，将从上一个已完成检查点恢复并重跑该轮。

### 单 Agent round

与现在完全相同：

```text
checkpoint N
→ 恢复累计 workspace patch
→ 恢复 ledgers
→ 从 round N+1 启动新 worker
```

### 使用过子 Agent 的 round

同样恢复最终整合状态：

```text
checkpoint N
→ 验证 execution manifest
→ 恢复最终累计 workspace patch
→ 恢复 ledgers
→ 从 round N+1 启动新的 worker
```

旧子 Agent session 不需要恢复。它们只是历史 provenance。下一轮 worker 可以重新自主决定是否调用新子 Agent。

**与原 PACT resume 兼容的根本原因**在于，多代理 v1 并未改变原 PACT 恢复机制所依赖的任何不变量：

- **单写入者不变量**：专家全程只读，规范工作区始终由唯一的 `pact-worker` 修改。恢复时重放的补丁与旧版本生成的补丁具有相同结构，driver 的验证逻辑无需改变。
- **检查点结构不变量**：多代理工件 `round-NN-execution.json` 是附加的可选文件，不影响 `pact-round-checkpoint/v1` 的必填字段。旧版恢复逻辑遇到该文件时直接忽略，不会破坏校验。
- **会话无状态性**：专家会话不持久化到检查点中。恢复时无需感知上一轮是否发生了委派，只需从干净的 worker 会话重新执行。这意味着崩溃恢复路径与单代理路径完全一致。
- **轮次边界不变量**：worker 进程退出仍是唯一的轮次边界，多代理执行发生在同一个 worker 生命周期内，不引入新的边界事件，因此 driver 的轮次推进与台账写入逻辑不受影响。

## 安全性理由

若允许多个代理写入同一工作区，将使补丁溯源、验证时机与确定性恢复变得不可靠。因此，v1 在不改变单写入者事务边界的前提下，引入可并行化的推理结构。未来版本可能增加后台只读汇合或隔离实现工作树，但这需要持久化汇合状态与独立集成协议。