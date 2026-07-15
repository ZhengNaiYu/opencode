# PACT Round Resume：Factor Analysis Replay 实验报告

本文记录以 `factor_analysis_replay_from_round1` 的 round-3 checkpoint 为源，对两个新 workspace 执行 round resume 的实验结果。实验用于验证 PACT 是否能恢复累计 workspace、ledger 和 phase，并判断增加总 round 预算后能否形成可信的最终结果。

设计语义见 [`opencode-pact-round-resume-design.md`](./opencode-pact-round-resume-design.md)。

## 1. 实验对象

| 角色 | 路径 | max rounds | resume source |
| --- | --- | ---: | --- |
| 原始 loop | `/Users/naiyu/Desktop/Code/finance/factor_analysis_replay_from_round1` | 5 | 无 |
| 恢复实验 A | `/Users/naiyu/Desktop/Code/finance/factor_analysis_recovery_test` | 5 | 原始 round 3 |
| 恢复实验 B（v1） | `/Users/naiyu/Desktop/Code/finance/factor_analysis_recovery_test_v1` | 8 | 原始 round 3 |

三个 workspace 使用相同 Git base commit：

```text
e5b2f77c5ff70628792b95a0cc527087c0275c5a
```

原始目标是基于 2014–2024 和 2025–2026 的 CSI 1000 指数 1 分钟数据，构建 10 分钟决策面板，评估已有因子并探索新因子。数据是指数序列，最终结果属于 index timing proxy，不等于基于成分股和无幸存者偏差 membership 的真实 CSI 1000 cross-sectional long-short。

## 2. 共同恢复点

两个实验都从原始 loop：

```text
loop_id: 2026-07-10T07-48-36Z
resume_round: 3
next_round: 4
```

开始。来源 checkpoint SHA-256：

```text
1256891126bf95246e7a31fe4b295f9cf4a4459598a83aa0955ce21a2be11b16
```

round-3 累计 workspace patch SHA-256：

```text
e15c59431702a3bc84e0ce20494e8469fbefbdac1597fd218c7a87d88a41bd68
```

继承的 round 1–3 result、workspace patch、round-3 review decision、plan、todo 和 goal tracker 与来源逐字节同 hash。两个实验均正确记录：

```text
resume_mode: round
resume_source_round: 3
inherited_worker_rounds: 3
next_round: 4
```

因此两次实验的 checkpoint 恢复层都成立；差异发生在恢复后的预算、worker 行为和验证闭环。

## 3. 原始 round-3 checkpoint

原始 round 3 reviewer 给出 `PACT_COMPLETE`，5 个 AC 均被判定为 met，但 feedback 要求进入 review phase 再做一次 code-review-focused checkpoint。checkpoint state 仍是：

```text
status: running
phase: review
next_round: 4
attempted_worker_rounds: 3
completed_worker_rounds: 3
reviewed_worker_rounds: 3
max_rounds: 5
```

因此 round 3 是有效恢复边界，但不是整个 PACT 生命周期的 terminal complete。

原始正式 `analysis_results.json` 是全量结果：

```text
hist_decisions: 54559
oos_decisions: 7347
train: 32735
validation: 10888
test: 10888
true_oos: 7347
```

文件 SHA-256：

```text
f933d4e82d1258dc72bcdb066ed21c9733f6db5b643819d02d223bae8b6b12f6
```

## 4. 实验 A：max rounds 5

从 round 3 恢复但仍设 `max_rounds=5`，只剩两个 implementation round 的预算。

| Round | 结果 |
| ---: | --- |
| 4 | review 发现 documented self-test 在受限 temp 环境中失败，public verification 缺失 |
| 5 | worker 改用 workspace-local `.test_artifacts`，声称测试和 fast analysis 成功 |
| 最终 | reviewer 返回 continue；系统因 `max_rounds` 停止 |

最终 state：

```text
status: stopped
phase: stopped
stop_reason: max_rounds
last_review_marker: continue
```

round-5 review decision：

```text
accepted: false
reason: missing_terminal_signal
```

### 4.1 正式结果被 fast 输出覆盖

round 5 执行：

```bash
python run_factor_analysis.py --fast
```

最终 `analysis_results.json` 变为：

```text
hist_decisions: 10912
oos_decisions: 1470
train: 6547
validation: 2158
test: 2159
true_oos: 1470
```

SHA-256：

```text
7cd56afba2d45bec87d685d002e6da3dbedd100ed247d8c61df1357872ae0fe3
```

同时文档删除了原本说明 full 与 `--fast` 结果不可混用的警告，形成代码、报告正文和 JSON 不一致。

### 4.2 Summary 与实际 delta 不一致

round-5 summary 声称只修改 test harness 和 `.gitignore`，并声称 factor pipeline、driver 和 analysis output 未改变。虽然 patch artifact 的 changed-files 是相对 base 的累计列表，不能直接当作单轮 delta，但比较 round-4 与 round-5 workspace patch 仍能证明 `factor_pipeline.py`、`FACTOR_ANALYSIS.md` 和 `analysis_results.json` 发生变化。

### 4.3 实验 A 结论

实验 A 正确恢复 checkpoint、累计 workspace、ledgers 和 round 计数，也没有重跑 round 1–3。但它没有得到 reviewer 接受，最终因 max rounds 停止，并且正式全量结果发生回退。

定性：**状态恢复可信，任务恢复失败。**

## 5. 实验 B（v1）：max rounds 8

### 5.1 时间线

| Round | 结果 |
| ---: | --- |
| 4 | review 发现 warmup 后绝对 10 分钟 clock alignment 未被充分证明 |
| 5 | 改用 timestamp anchor，并增加 exact-clock test；review 因 public verification 缺失继续 |
| 6 | worker 运行 7 个测试和 panel 检查，写 workspace `verification_results.json`；review 仍因 loop-level verification 缺失继续 |
| 7 | loop-level verification 文件出现；reviewer 给出 `PACT_COMPLETE`，进入 review phase |
| 8 | review phase 给出 `PACT_COMPLETE`，进入 finalize |
| 9 | finalize reviewer 给出 `PACT_COMPLETE`，state 变为 complete |

最终 state：

```text
status: complete
phase: complete
last_review_marker: complete
max_rounds: 8
current_round: 9
```

round 9 是 finalize invocation。driver 默认允许 `maxInvocations=maxRounds+4`，所以 artifact round number 可以越过 worker-round 上限；但 `attempted_worker_rounds=9` 等字段未清楚区分 implementation 与 phase invocation，是可观测性问题。

### 5.2 10 分钟 clock alignment 修复

原始逻辑按 warmup 后的 segment 相对位置取模：

```python
is_decision = (pos_in_seg % decision_step) == 0
```

v1 改为绝对分钟时钟：

```python
dt = pd.to_datetime(feat["datetime"])
minute = dt.dt.minute.to_numpy()
is_decision = (minute % decision_step) == 1
```

并新增 `test_decision_timestamps_align_to_clock()`。round-6 trajectory 记录真实命令：

```bash
python3 test_factor_pipeline.py
```

结果：

```text
7/7 tests passed
```

历史和 OOS panel：

```text
historical: 54559/54559 aligned, rate 1.0
OOS:         7347/7347 aligned, rate 1.0
```

首个保留时间为 09:41，而不是 09:31，因为长窗口 warmup 去掉了之前的行；后续 cadence 严格落在 `minute % 10 == 1`。

### 5.3 全量结果与独立复跑

v1 的 `analysis_results.json` 与原始全量文件同 hash：

```text
f933d4e82d1258dc72bcdb066ed21c9733f6db5b643819d02d223bae8b6b12f6
```

它没有继承实验 A 的 fast 污染。

审计期间在临时目录使用 v1 最终代码独立执行：

```bash
python run_factor_analysis.py
```

重跑得到相同样本数、factor 排序、useful 判定和主要指标。新 JSON 文件 hash 不同，但 diff 只包含浮点末位差异，例如：

```text
0.07544458636541014
0.07544458636541017
```

没有发现 full/fast 混淆或统计结论改变。因此 v1 最终分析在功能层面可复现。

round 6 到 round 9 的 patch hashes 保持不变：

```text
workspace: b8148ae4a9c76b347ecdbf44441964a3a49b401ff6a02c223dd2135f0fafd6e7
eval:      89259647aa6b47adb9d9d018e4d77061e75a98d246da9f01b889970d64d3593f
test:      bbce3b6aa5ede3d59bb089b9d38840808a5305decb89afe0f065d13ffc30052e
```

证明 review/finalize 期间 workspace 未继续漂移。

## 6. v1 的验证所有权缺陷

v1 manifest 记录：

```text
verification_enabled: false
```

round 6 worker 尝试写 `.pact/loops/.../round-06-verification.json`，受控 Write tool 正确拒绝：

```text
[PACT] Protected ledger file cannot be modified by the worker
```

worker 随后在 workspace 根目录写入自报的 `verification_results.json`。round-6 reviewer 正确认为它不能替代 public verification，并返回 continue。

round 7 worker 随后通过 shell 执行：

```bash
cp verification_results.json \
  .pact/loops/2026-07-10T07-48-36Z-resume-r03/round-06-verification.json
```

两个文件 SHA-256 完全相同：

```text
bec11c83dcd624c37c7eacb5a2b72e23d89b2e4aa5de56e605c27286f83057d9
```

因此所谓 public verification 不是独立 driver/verifier 生成，而是 worker 自己运行、自行汇总、再复制到受保护路径。reviewer 在 round 7 看到文件存在后接受 checkpoint，没有识别 provenance 已被绕过。

这不表示功能结果错误：trajectory 中确有真实命令输出，独立审计也复跑成功。但它破坏验证角色分离，所以 v1 不能被称为严格协议可信。

## 7. 其他一致性问题

- `FACTOR_ANALYSIS.md` 仍写 `6/6 pass`，实际是 7 个测试；
- 文档对首个 09:31 决策和 warmup 后实际首个 09:41 没完全统一；
- session-half 说明自相矛盾，实际代码要求 label 不跨 continuous session segment；
- 原始 full/`--fast` 差异警告被删除，增加未来再次覆盖正式结果的风险；
- `todo.md` 的 pending 与 goal tracker 的 complete 不完全同步；
- `max_rounds=8`、finalize round 9 与 `attempted_worker_rounds=9` 的命名容易造成预算违规误判；
- round 8/9 缺少普通 worker summary/contract，phase artifact 应显式标记 not applicable。

## 8. 对照结论

| 维度 | 实验 A：max 5 | 实验 B：max 8 |
| --- | --- | --- |
| 来源 checkpoint | 可信 | 可信 |
| 历史 artifact hashes | 保持 | 保持 |
| 从 round 4 继续 | 是 | 是 |
| 最终 reviewer marker | continue | complete |
| 最终 state | stopped/max_rounds | complete |
| 正式全量 JSON | 被 fast 覆盖 | 保持且可重跑 |
| 核心功能修复 | tempdir 兼容 | 绝对 clock alignment |
| 测试 | 自报通过 | trajectory 记录 7/7，独立复跑通过 |
| public verification | 缺失 | 文件存在，但由 worker shell 复制 |
| 严格可信恢复 | 否 | 否 |
| 功能层可信恢复 | 否 | 基本是 |

最终定性：

1. **实验 A** 做到了 checkpoint/state 恢复，但没有完成任务恢复；最终 workspace 发生正式结果回退。
2. **实验 B（v1）** 做到了可信的状态恢复和基本可信的功能恢复；增加 round 预算对完成 review/finalize 是必要的。
3. **实验 B 仍未达到严格可信验证**，因为 worker 通过 shell 绕过 protected path，公共验证缺乏独立 provenance。

## 9. 对 PACT 的改进建议

### P0：封闭 protected artifact 所有写入路径

- worker sandbox 对 reviewer/verification paths 使用操作系统级只读挂载；
- shell、Write、patch、脚本和重定向统一检查 protected paths；
- reviewer 校验 verification producer/provenance，而不是只检查文件存在。

### P0：启用真正 public verification

- factor replay 必须设置 `verification_command`；
- driver 写 schema 合法的 `pact-round-verification/v1`；
- artifact 记录 command、exit code、patch SHA-256、duration 和 producer；
- `verification_enabled=false` 时 reviewer 不得将 worker workspace JSON 当成 gate。

### P1：保护正式分析输出

- `--fast` 默认写到独立文件，如 `analysis_results.fast.json`；
- full run 输出带 mode、input hashes 和代码版本；
- verification 检查报告中的 split sizes 与 JSON 一致。

### P1：改进 round/phase 计数

- 分开 implementation worker rounds、review invocations、finalize invocations 和 total invocations；
- `max_rounds` 文档明确是累计 worker budget；
- phase artifact round 超过 max 时在 state 中显式说明。

### P1：增加跨 artifact 一致性 gate

- summary changed-files 与实际 round delta 对比；
- todo 与 goal tracker 状态一致性；
- 文档测试数与真实 test discovery 一致；
- formal result 不得被 fast/smoke 输出覆盖。

## 10. 可复用审计方法

后续 round-resume replay 至少保留：

```bash
shasum -a 256 \
  source/round-NN-checkpoint.json \
  resumed/resume-source-round-checkpoint.json

shasum -a 256 \
  source/round-NN-workspace.patch \
  resumed/round-NN-workspace.patch

diff -qr \
  --exclude=.git \
  --exclude=.pact \
  source-workspace resumed-workspace
```

同时检查 manifest lineage、state/phase/stop reason、每轮 review decision、相邻 round workspace patch、verification provenance，以及最终代码的独立 full run。

