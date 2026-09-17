# 变更记录 · /knowledge 改为原子提交并复核版本

- **日期**：2026-09-17
- **轮次**：第 8 轮
- **负责人**：C
- **范围**：`/knowledge` 的提交时机；并顺带补齐 `/gap` 的同类并发缺口
- **依据**：`docs/微积分学伴_项目说明书.md` V1.4 第 9.3 节
- **对应 LearnBuddy 对话**：本轮「四阶段交付：探索 → 实现 → 自测 → 提交清单」

## 一、依据原文

说明书 V1.4 第 9.3 节明确指派：

> 「`/knowledge` 当前先写材料，再等待模型结果；与"失败保留旧状态"不一致」
> → **C负责**：先分析与校验，提交前再次核对会话版本，成功后一次性更新。
> **模型失败时材料与版本不变；并发旧响应不能覆盖新状态。**

C3 验收条件同款：**模型成功并通过校验后才提交材料；响应提交前复核版本。**

## 二、缺陷与根因

`apps/server/src/http/routes.ts` 里 `/knowledge` 的两行顺序反了：

```ts
const updated = incoming.length > 0 ? applyMaterials(session.id, incoming) : session;
//                                     ↑ 立刻写库：材料入库 + materialVersion +1
const result = await teaching.analyzeKnowledge({ materials: toSlices(updated) });
//                                     ↑ 模型才刚被调用
```

`applyMaterials` 是**立即写入**，且没有回滚路径。因此模型一旦失败（超时 / 认证 / 额度 / 上游异常），
材料和版本**已经被改动**，与"失败保留旧状态"直接冲突。

**讽刺之处**：上一行注释写着「材料写入失败时不动已有状态（说明书 2.4）」——
代码只实现了"写入失败"，**没有实现"模型失败"**。

同类问题在 `/gap` 上存在一半：它的顺序是对的（先调模型再提交），
但**只在请求入口校验过一次版本**，模型调用期间（约 1—3 秒）若有并发请求提交过，提交仍会覆盖新状态。

## 三、改了什么

| # | 文件 | 变更 |
|---|---|---|
| 1 | `apps/server/src/store/index.ts` | **只新增，不改现有函数**：新增 `SessionVersionConflictError`、`previewMaterials()`（纯函数候选）、`commitMaterials()` / `commitSupplement()`（带版本前置条件的提交）、内部 `assertVersionUnchanged()` |
| 2 | `apps/server/src/http/routes.ts` | `/knowledge` 处理体改为「记版本 → 查配额 → 构造候选 → 调模型 → **复核版本** → 一次性提交」；`/gap` 补上提交前复核；`errorHandler` 新增 `SessionVersionConflictError` 分支；store 导入项同步 |
| 3 | `apps/server/package.json` | 新增 `verify:store` 脚本入口 |
| 4 | `apps/server/scripts/verify-knowledge-commit.mjs` | **新建**：store 层原子提交验证脚本（22 项检查，不消耗额度） |
| 5 | `docs/changelogs/2026-09-17-C-knowledge原子提交.md` | **新建**：本文件 |

**新增依赖：无。契约未改动** —— `KnowledgeRequest` 不需要新增 `materialVersion` 字段，
版本复核在服务端内部完成。**因此 A 的前端与 B 的教学模块均零影响。**

## 四、三条实现要点

### 1. 候选只存在于内存

`previewMaterials(session, incoming)` 是**纯函数**：返回「写入后会得到的会话」，
但**不触碰存储**。模型分析的是这个候选，所以失败时什么都不会留下。

### 2. 版本复核落在存储层，不在路由层

`commitMaterials(sessionId, materials, expectedVersion)` 是 compare-and-swap：
版本不符即抛 `SessionVersionConflictError`，路由与错误映射都不必自己判断版本。

**⚠️ 已写进代码注释的约束**：检查与写入之间**不得出现 `await`**。
本模块是同步内存实现，两句连着写即有效；若将来改为异步存储或数据库，必须换成事务或真正的 CAS 写。

### 3. 冲突映射为 409 + `SESSION_STALE`

| 项 | 值 | 说明 |
|---|---|---|
| HTTP 状态 | **409** | 语义上比 400 更准确（并发冲突） |
| `error.code` | **`SESSION_STALE`** | 与 `/tutor`、`/gap` 入口校验**同一个错误码**，前端按 `code` 处理即可 |
| `retryable` | **true** | 基于最新状态重试即可 |

**已知的小不一致**：入口处 `assertVersion` 抛出的 `SESSION_STALE` 走 `ApiError` 分支，
是 400 + `retryable:false`；本次新增的是 409 + `retryable:true`。
两者 `code` 相同、前端处理一致，但状态码与 retryable 不同。
**建议后续统一**，本轮未改动既有行为以免扩大影响面。

## 五、验收结论（全部真实执行）

### 静态检查

| 项 | 结果 |
|---|---|
| `npm run typecheck`（四个 workspace） | **零错误** |

### store 层（`npm run verify:store`，不消耗额度）

| 项 | 结果 |
|---|---|
| 全部检查 | **22 项通过、0 项失败** |

覆盖：候选不落盘、模型失败（预览后不提交）时材料与版本不变、
正常提交版本 +1、空材料只复核不递增、**过期版本被拒绝且存储未被覆盖**、
补充块同样受保护、会话不存在抛 `SessionNotFoundError`。

### 接口层（真实 HTTP）

| 测试 | 方法 | 结果 |
|---|---|---|
| 既有能力未受影响 | `MODEL_PROVIDER=mock` + 29 项冒烟 | **29 项通过、0 项失败** |
| **模型失败不变更** | `MODEL_TIMEOUT_MS=1` 使所有模型调用必定失败 → 调 `/knowledge` → 再用配额报错读出材料数 | 报错 `模型通道超过 1 毫秒未返回，已中止，可重试`；随后配额文案为「当前已有 **0** 份材料」→ **未落盘** ✓ |
| **并发旧响应防护** | 同一会话并发两个 `/knowledge`（都基于版本 0） | 请求A **200**（`materialVersion=1`）；请求B **409** `SESSION_STALE`「本次分析基于版本 0，当前已是 1」✓ |

第二条测试的关键：**"当前已有 0 份"就是决定性证据** —— 改之前这里会显示 1 份。

## 六、过程中发现的两个问题（如实记录）

1. **测试环境反复踩同一个坑**：测试用的服务进程未被彻底关闭，导致后续启动报
   `EADDRINUSE`，而冒烟测试**打到了旧进程上**（属无效验证）。
   已改为**每次测试前先断言端口监听数为 0**，并在启动后记录监听 PID。
   此前一轮也犯过同样的错，本轮已把它固化进流程。

2. **`ModelError` 未映射到 HTTP 状态**：超时测试中，模型超时返回的是
   **500 `INTERNAL`**，而不是 `504 MODEL_TIMEOUT`。因为 `errorHandler` 只识别
   `ApiError`、`SessionNotFoundError` 和本轮新增的 `SessionVersionConflictError`。
   这属于说明书 V1.4 已点出的「C负责统一映射认证、额度、超时与上游错误」，**本轮未处理**。

3. **Windows 下 `curl -o /tmp/…` 静默失效**：`curl` 是 Windows 程序，不认 Git Bash 的 `/tmp`，
   响应体被写到别处（HTTP 状态码正常，所以不易察觉）。已改用仓库内 `.tmp/`。
   同类问题此前在 `git commit-tree -F /tmp/…` 上出现过。

## 七、遗留与建议

| # | 事项 | 归属 |
|---|---|---|
| 1 | **统一 `ModelError` → HTTP 状态映射**（认证 401、额度 429、超时 504、上游 502） | C，下一轮 |
| 2 | 统一 `SESSION_STALE` 的状态码与 `retryable`（400/false vs 409/true） | C，可择机 |
| 3 | 60 秒总预算与重试计入同一预算 | C，下一轮 |
| 4 | `/api/parse` 接入真实识图 | 等 B 提供解析函数 |
| 5 | 云端独立验证 | 需负责人提供部署资源 |

## 八、真实性声明

第三节的改动、第五节的验收数据均来自实际执行输出，含真实 HTTP 并发请求与真实模型超时注入。
第六节完整记录了三处过程问题（含一次**无效验证**与两次平台路径坑），未作淡化。

**本次未执行任何 git 提交** —— 按项目规则，提交前须先获得负责人确认。
