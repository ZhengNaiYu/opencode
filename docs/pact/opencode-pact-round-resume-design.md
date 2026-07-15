# OpenCode PACT Round Resume：如何恢复

PACT round resume 从一个已经完成 review 的 round checkpoint 恢复 workspace 和执行状态，然后在新的 loop 中从下一轮继续。

例如，从 round 3 恢复：

```text
源 loop round 3 checkpoint
        │
        ├── 恢复 round 3 累计代码改动
        ├── 恢复 round 3 review 后的 plan/todo/goal tracker
        ├── 继承已完成的 round 1–3 计数和历史 artifacts
        └── 清除旧 session ID
                     │
                     ▼
新 loop 从 round 4 开始
```

源 loop 不会被继续写入；resume 会创建一条独立分支。

## 1. 恢复命令

```bash
opencode-pact-driver \
  --resume-loop /path/to/source/.pact/loops/<loop-id> \
  --resume-mode round \
  --resume-round 3 \
  --max-rounds 8 \
  /path/to/target/plan.md
```

关键参数：

- `--resume-loop`：源 loop 目录；
- `--resume-round 3`：恢复 round 3 review 完成后的状态；
- `--max-rounds 8`：整条执行最多允许 8 个 worker rounds，不是额外增加 8 轮。

从 round N 恢复时必须满足：

```text
max_rounds > N
```

从 round 3 恢复并设置 `max_rounds=5`，只剩 round 4、5 两个 worker-round 名额；设置为 8，则还剩 5 个。

## 2. Checkpoint 保存了什么

每个完成 review 的 round 都生成：

```text
round-NN-checkpoint.json
```

它不是代码副本，而是一份带哈希的恢复清单，主要记录：

| 内容 | 用途 |
| --- | --- |
| `base_commit` | 确认目标仓库和源 loop 使用同一个 Git 基线 |
| PACT state | 恢复 status、phase、next round 和 round 计数 |
| `round-NN-workspace.patch` | 从 base commit 恢复截至 round N 的全部代码改动 |
| workspace patch SHA-256 | 检查 patch 没有被替换或修改 |
| plan/todo/goal tracker SHA-256 | 恢复并检查 round N review 后的 ledger |
| result/review decision SHA-256 | 检查该 round 的执行和 review 记录 |
| next prompt/feedback SHA-256 | 生成下一轮时使用正确的 review 上下文 |

顶层的 `plan.md`、`todo.md`、`goal-tracker.md` 会随着后续 round 改变，因此不能作为历史恢复源。resume 使用 checkpoint 指向的 `round-NN-*-post.md` 快照。

## 3. 哈希具体解决什么问题

SHA-256 用来确认“现在读取的文件就是 checkpoint 创建时的那个文件”。

以 factor-analysis round 3 为例：

```text
round-03-checkpoint.json
SHA-256:
1256891126bf95246e7a31fe4b295f9cf4a4459598a83aa0955ce21a2be11b16

round-03-workspace.patch
SHA-256:
e15c59431702a3bc84e0ce20494e8469fbefbdac1597fd218c7a87d88a41bd68
```

resume 创建新 loop 后，还会复制 checkpoint 为：

```text
resume-source-round-checkpoint.json
```

源 checkpoint 和复制文件必须同 hash：

```bash
shasum -a 256 \
  source/round-03-checkpoint.json \
  resumed/resume-source-round-checkpoint.json
```

如果两个输出不同，说明 checkpoint 在复制前后发生变化，恢复不可信，应立即停止。

同样，checkpoint 内记录的 workspace patch、plan、todo、goal tracker 和 review decision 的 hash 都必须与实际文件相同。这样可以发现：

- checkpoint 被修改；
- 恢复了错误 round 的 patch；
- ledger 已被后续 round 覆盖；
- artifact 被手工替换；
- 复制过程不完整。

哈希只能证明文件内容一致，不能证明代码逻辑正确。逻辑正确性仍需测试和独立 verification。

## 4. 实际恢复顺序

driver 按以下顺序恢复：

1. 读取并验证 `round-NN-checkpoint.json`；
2. 检查目标仓库当前 `HEAD == checkpoint.base_commit`；
3. 创建新的 resume loop 目录；
4. 恢复 round N 的 plan、todo 和 goal tracker 快照；
5. 在目标仓库应用累计 `round-NN-workspace.patch`；
6. 检查 patch 能正确应用，并校验恢复后的 workspace；
7. 复制 round 1..N 的 result、review、patch 等历史 artifacts；
8. 继承 attempted/completed/reviewed round 计数；
9. 清除旧 worker session ID，避免连接到源 loop 的模型会话；
10. 写入来源信息和 checkpoint hash；
11. 根据 round N review feedback 重新生成 round N+1 prompt；
12. 启动新的 worker session，从 round N+1 继续。

恢复后的 `loop-manifest.json` 会明确记录来源：

```json
{
  "resume_mode": "round",
  "resume_source_loop": "/path/to/source-loop",
  "resume_source_loop_id": "2026-07-10T07-48-36Z",
  "resume_source_round": 3,
  "resume_checkpoint": "/path/to/round-03-checkpoint.json",
  "resume_checkpoint_sha256": "125689...",
  "inherited_worker_rounds": 3,
  "next_round": 4,
  "max_rounds": 8
}
```

## 5. 什么情况下拒绝恢复

以下任一情况都不应继续：

- checkpoint 或 checkpoint 引用的文件缺失；
- 文件实际 SHA-256 与 checkpoint 记录不同；
- 目标 Git `HEAD` 与 `base_commit` 不同；
- 累计 workspace patch 无法通过 apply check；
- patch 应用后的 workspace 与预期不一致；
- checkpoint 已是 terminal complete；
- `max_rounds <= resume_round`。

这些检查防止“看起来从 round 3 恢复，实际代码或 ledger 来自其他状态”。

## 6. 恢复成功不等于任务完成

需要分开判断：

### 恢复是否正确

- checkpoint 和来源副本同 hash；
- base commit 相同；
- workspace patch 和 ledger 恢复正确；
- 新 loop 从 N+1 开始；
- round 1..N 历史 artifacts 保持不变。

### 恢复后的任务是否完成

- 最终 `state.status == complete`；
- reviewer 最终返回 `PACT_COMPLETE`；
- 正式测试或分析可以重跑；
- 输出没有被 `--fast`、smoke test 等临时结果覆盖；
- 文档、代码和结果一致。

因此 `stopped/max_rounds` 只表示恢复流程运行过并耗尽预算，不表示任务完成。

## 7. Verification 必须独立

worker 可以运行测试并写 summary，但不能自己给自己生成公共验证结论。

正确流程是：

```text
worker 修改代码
      │
      ▼
driver/verifier 独立运行 verification_command
      │
      ▼
driver 写 round-XX-verification.json
      │
      ▼
reviewer 根据验证产物决定 continue 或 PACT_COMPLETE
```

只有设置了 `verification_command`，manifest 才应记录：

```text
verification_enabled: true
```

若为 `false`，worker 写出的 `verification_results.json` 只是自报结果，不能等价为独立 public verification。

当前还存在一个需要修复的边界：受控 Write tool 会阻止 worker 写 PACT-owned verification 文件，但 shell `cp` 或重定向也必须受到同样限制。否则 worker 可以绕过 protected-path 检查，伪造“独立”验证文件。

## 8. 最小审计清单

一次可信 resume 至少检查：

```bash
# 1. checkpoint 复制前后相同
shasum -a 256 \
  source/round-NN-checkpoint.json \
  resumed/resume-source-round-checkpoint.json

# 2. 恢复的是同一 Git 基线
git rev-parse HEAD
jq -r .base_commit resumed/resume-source-round-checkpoint.json

# 3. 检查来源、round、预算和最终状态
jq '{
  resume_source_loop,
  resume_source_round,
  resume_checkpoint_sha256,
  inherited_worker_rounds,
  next_round,
  max_rounds,
  verification_enabled
}' resumed/loop-manifest.json

jq '{status, phase, stop_reason, last_review_marker}' resumed/state.json
```

最后还应独立运行项目的正式测试或分析命令。哈希证明恢复输入没有变，测试和 verification 才证明恢复后的结果可用。

