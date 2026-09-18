# 契约变更：`TutorResponse` 增加 `droppedBlocks`（加性）

> 时间：2026-09-17 ｜ 发起：C（`apps/server` + `packages/contracts` 所有者）
> 对应缺陷：`docs/todo.md` **`I14`**（来源校验静默丢弃被拒块）
> 涉及三处同步：`packages/contracts/src/tutor.ts`、`docs/知识库.md` §5、本文件
> **消费方确认状态：未确认（需 A 确认渲染侧、B 确认校验语义）** —— 见 §4

---

## 1 变更内容

`packages/contracts/src/tutor.ts`：

```ts
export interface DroppedBlocks {
  /** 被拒块的数量 */
  count: number;
  /** 去重后的拒绝原因（如「AI 补充内容未经学生授权」） */
  reasons: string[];
}

export interface TutorResponse {
  scope: AnswerScope;
  blocks: AnswerBlock[];
  basedOnMaterial: boolean;
  nextStep?: NextStep;
  droppedBlocks?: DroppedBlocks;   // ← 新增（可选）
}
```

**只有这一个新增字段，没有删改任何既有字段、没有改任何既有字段的类型或语义。**

---

## 2 为什么需要

`POST /api/tutor` 的来源校验（说明书 §4.3、用例 E7）会拒掉不合法块。原实现是：

```ts
if (valid.length === 0 && rejected.length > 0) throw new ApiError('UNAUTHORIZED_CONTENT', ...);
```

**只在"全部被拒"时报错**。一旦有块通过，`rejected` 里的块就从响应中消失了 ——
学生看到一段残缺的答案，且**无从知道少了一段**。直接违反纪律 2「不得静默：丢弃、降级、跳过，都必须让学生看得见」。

---

## 3 取舍：为什么是"加字段"而不是"降级为标注块"

`todo.md` 的 `I14` 给了两条路。选前者的理由：

| 方案 | 结果 |
|---|---|
| **降级为标注块**（把被拒内容作为一条"标注块"塞回 `blocks[]`） | ❌ `AnswerBlock.sourceType` 只有 `material` / `derived` / `ai-supplement` 三类（§4.3）。被拒块之所以被拒，恰恰是**它的来源声明不成立** —— 给它挑一个 `sourceType` 就是在替它做一个已经被驳回的声明。若把内容本身也带出去，等于绕过了校验；若只带一句"某段被拦下"，那它就不是一个回答块，塞进 `blocks[]` 是类型滥用 |
| **加性可选字段**（本次采用） | ✅ 语义准确：它描述的是**这次响应的完整性**，不是回答内容。可选 ⇒ 旧消费方忽略即可，不构成破坏性变更（对齐 `P-C12` 给 `HealthResponse` 加 `build?` 的同一做法） |

---

## 4 消费方影响与待确认

| 消费方 | 影响 | 需要谁确认 |
|---|---|---|
| `apps/server`（发起方） | 只在"部分被丢弃"时填该字段；全部被拒仍走 403，不填 | — |
| `apps/web`（**A 的工件**） | **必须渲染**，否则等于换个地方继续静默。本轮已代改 `components/TutorPanel.tsx`（显示"本次回答不完整：另有 N 段…"），**并已按纪律标注、请 A 复核** | **A** |
| `packages/teaching` | 无影响：它返回的是 `valid`/`rejected` 的原始结果，不做丢弃决策 | B（确认与 §4.3 校验语义一致即可） |

⚠️ **按 `知识库.md` §10.1，契约变更须 A/B 确认后消费方才能跟进。本次是 C 单方面发起并同时改了 A 的界面文件** —— 这一点必须由 A 在复核时明确接受或回退。
**不接受"因为改了很小所以不必确认"** —— `I12`/`I15` 的教训正是"小改动没人复核就会留在那里"。

---

## 5 已知限制

1. **服务端分支没有端到端断言**：`verify:flow` 用的是 mock 通道，mock 的回答**恒为单块**，
   造不出"部分通过、部分被拒"的输入。因此该字段的**服务端填充逻辑**目前只由
   `verify:flow` 的一条**否定断言**覆盖（正常回答不带该字段），**正面路径未被自动断言**。
   如实登记，不假装覆盖。
2. **渲染侧已断言**：`verify:render` 新增 4 项（含渲染不抛异常），锁住"文案真的出现在 HTML 里"。
3. 字段名用复数 `droppedBlocks` 而非 `droppedCount`：`count` 之外还需要交出 `reasons`
   （学生要知道"为什么被拦"），只报数字仍是半静默。
