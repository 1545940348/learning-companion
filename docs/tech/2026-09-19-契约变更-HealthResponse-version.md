# 契约变更：`HealthResponse.version` 由 `string` 收窄为 `string | null`（`I17`）

> 日期：2026-09-19 · 发起：C · 影响面：`GET /api/health` 响应一个字段 · 消费方核查：`apps/web` 不读该字段

---

## 1. 变更内容

```diff
 export interface HealthResponse {
   ok: boolean;
-  version: string;
+  /** 运行时读取 @lc/server 的 package.json；取不到即 null */
+  version: string | null;
   modelProvider: string;
   mock: boolean;
   verification: VerificationEngineStatus;
   build?: BuildInfo;
 }
```

同时服务端实现从**硬编码**改为**运行时读取**（`apps/server/src/config/build-info.ts` 新增 `describeVersion()`）。

## 2. 为什么改（问题是什么）

- 原实现：`routes.ts` 里 `version: '0.2.0'` —— **全仓没有任何 `0.2.0` 的出处**，五个 `package.json` 都是 `0.1.0`，
  也没有对应 tag。评委对照源码仓库时，会先看到这个**对不上的数字**。
- 硬编码的第二个问题：它**不随包版本升级而变**，等于把"漂移"写进了代码 —— 下次升版本必然再对不上。

## 3. 定下的口径（负责人 2026-09-19 拍板）

- **取 `@lc/server` 自己的 `package.json` 版本**（回答"这个服务是哪个版本"），按四个候选位置探测
  （产物态 / 源码态 / 两种工作目录），**取不到即 `null`**；
- **刻意不做**"找不到就退回硬编码"的兜底 —— 那等于把同一个失真换个地方藏起来；
- 与既有 `build.builtAt` 完全同一思路（`P-C12` 已确立）：**取不到就如实报 `null`，不编一个看起来合理的值**。

## 4. 兼容性评估（为什么可以现在就改）

| 消费方 | 是否读 `version` | 结论 |
|---|---|---|
| `apps/web`（全部源码） | **不读** | 界面不展示版本号，无调用点 |
| `apps/server/scripts/verify-dist.mjs` | 不读（只断 `mode === 'dist'`） | 不受影响 |
| 其它 verify 脚本 | 不读 | 不受影响 |
| 外部使用者 | 无（未公开 SDK） | — |

**类型方向是"收紧"**（`string` → `string | null`）：TS 消费方若将来读它，会在编译期被迫处理空值 ——
这正是本变更想要的：**不允许把"取不到"当成"有值"**。

## 5. 配套动作

- `verify:flow` 新增 1 项断言（⑰）：`health.version` 必须等于脚本直接读到的 `package.json` 版本；
- `docs/知识库.md` §14 决策索引新增一行（`I17` 版本口径）；
- `docs/todo.md` 的 `I17` 行标记为已修复，并说明契约变更的兼容性核对结果。

## 6. 已知限制

- 若将来把 `@lc/server` 的 `package.json` 从镜像里剔除（例如多阶段构建只拷 `dist/`），
  `describeVersion()` 会返回 `null` —— 这是**故意的**：宁可如实报"不知道"，也不要报一个假的版本号。
  到那时若希望 health 仍能报版本，正确做法是**在构建期注入**（如 `tsup` 的 `define`）写进产物，
  而不是把硬编码加回来。
