# 契约变更 · `GET /api/sessions` 与 `SessionSummary`（2026-09-23）

> **性质**：**加性（additive）**变更 —— 只新增接口与类型，**不改动任何既有字段**。
> 既有消费方（前端）不传新字段、不调新接口时行为完全不变，因此**不需要同步升级**。
> **发起方**：本轮由助手按用户指令（「启动 P2」）**单方面发起** —— 按项目纪律，
> 契约变更需 A/B 复核后再由消费方跟进，**前端接入尚未开始**（见 §4）。
> 上游：`plans/2026-09-23-L档前端改造实施计划（两人份）.md` 的 **P2-1** 任务卡。

---

## 1. 变更摘要

| 项 | 内容 |
|---|---|
| 新增接口 | `GET /api/sessions` → `200` + `SessionListResponse` |
| 新增类型 | `SessionSummary`（`packages/contracts/src/session.ts`）、`SessionListResponse`（`packages/contracts/src/api.ts`） |
| 新增存储能力 | `apps/server/src/store/index.ts` 的 `listSessionSummaries()` |
| 契约版本 | 接口数 **10 → 11**（`docs/知识库.md` §5 已同步） |
| 破坏性 | **无**（加性） |

---

## 2. 为什么需要它

L 档改造后，主界面已能切换「对话 / 功能」，但左栏**只有当前一个会话** ——
要给出"历史会话列表"，前端必须能**先知道有哪些会话**。

当前唯一的会话相关接口是 `POST /api/session`（建会话），**没有任何"列出来"的能力**：

- 前端拿不到会话清单 → 只能靠本地记 ID，且刷新/换设备就断链；
- 直接返回整个 `Session` 又**不合适**：那会把**讲义原文**、图谱与补充块正文一并吐出来，
  而列表页一条都不需要。

⇒ 需要一个**只回元信息**的摘要接口。

---

## 3. 具体定义（照录）

```ts
/** packages/contracts/src/session.ts */
export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;        // 列表按它倒序
  materialVersion: number;
  materialCount: number;    // 学生自己提交的材料份数（不含 AI 补充块）；轻路径为 0
}

/** packages/contracts/src/api.ts */
export interface SessionListResponse {
  sessions: SessionSummary[];
}
```

**口径（写进代码注释，别回退）**：

1. **只回摘要，不回正文** —— 材料正文、图谱、补充块正文一律不进列表；
2. **按 `updatedAt` 倒序**，并以 `id` 作**平手次级键**（同一毫秒创建时顺序才确定 ——
   否则断言会偶发失败，看起来像 flaky，其实是排序不确定）；
3. **不做分页** —— 服务端是内存实现、单进程演示环境，会话量以个位计；
   加一个用不上的分页参数只会制造"看起来完备"的错觉；
4. **无入参、无需守卫** —— 不带 `sessionId`，因此不经过 `request-guards`；
5. **进程重启后列表为空** —— 内存实现的既定口径（说明书 §5.3），**不是故障**；
   消费方若接界面，必须如实说明这一点，不能显示成"你还没有会话"这种误导文案。

### 3.1 一处需要留痕的"回潮"（`I19`）

2026-09-18 的全量复查曾把 `store/index.ts` 的 `listSessions` 作为**死代码删除**（当时确实零调用点）。
本次以 `listSessionSummaries` 的形式加回 —— **判据仍是"有没有消费方"**：

- 真实消费方：`routes.ts` 的 `GET /api/sessions`（已实现）；
- 真实断言：`verify:graph` 的摘要节（10 项）+ `verify:flow` 的 HTTP 节（8 项）。

---

## 4. 影响面与消费方状态

| 角色 | 影响 | 状态 |
|---|---|---|
| `apps/server`（C） | 新增路由 + 存储函数 | ✅ **已实现并验证**（本轮） |
| `packages/contracts`（C） | 新增两个类型 | ✅ 已实现（**加性**） |
| `apps/web`（A） | **可**调用新接口；不调也不受影响 | ⬜ **未接入**（有意） |
| 既有断言 | 全部不受影响 | ✅ 已实测（见 §5） |

### 4.1 前端为什么**暂时不接**

不是遗漏，是**顺序**：左栏要列会话，就必须能**点进去切换**；而"切换会话"需要按
`sessionId` 恢复材料与图谱（`P2-2`，路线尚未拍板，见计划书 §四）。
在恢复能力落地前先把列表画出来，等于做一个**点了没用**的界面 ——
那正是本项目一直在防的"看起来有、实际没有"。

⇒ **P2-1 只交接口**；前端接入按 `P2-2` 的结论再排。

---

## 5. 验收（本轮实测）

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（4 工作区） | **0 error** |
| `verify:graph -w @lc/server` | **57 → 67 项 / 0 失败**（新增摘要节 10 项） |
| `verify:flow -w @lc/server`（真起 mock 服务端） | **48 → 56 项 / 0 失败**（新增 HTTP 节 8 项） |
| `verify:all -w @lc/server` | **301 → 311 项 / 0 失败** |
| 端到端判据 | 列表里**不出现材料正文**、**不出现图谱节点**、轻路径会话如实报 `0` 份材料 |

> **红/绿说明**：新增的 18 项断言都能真失败 —— 例如把 `materialCount` 改成常量、
> 或让摘要里带上 `session.materials`，对应的"不出现正文"与"份数正确"两条会立刻变红。

---

## 6. 回滚

**加性变更，回滚成本极低**：删掉 `apiRouter.get('/sessions', …)` 与两个类型即可，
既有消费方与既有断言不受影响。
