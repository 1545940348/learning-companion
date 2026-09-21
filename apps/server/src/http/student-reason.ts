/**
 * 把校验层的拒绝原因改写成**面向学生**的话术（`I35`）。
 *
 * 契约对 `droppedBlocks.reasons` 的定位就是"给学生看的说明"，而
 * `packages/teaching/src/validate.ts` 的三条 reason 都内插了 `citation.refId`
 * （补充块的 refId 是 `randomUUID`）—— 前端原样渲染，学生就会看到
 * 「引用的来源不存在：9f1c2b7a-…」这种内部标识。**内部 id 不该出现在学生界面上**。
 *
 * 处置选择：在**服务端**改写（而不是让前端去猜/去截断），原因有二 ——
 * ① 契约说这些字符串本就是给学生的话术，那就该由产出方保证它可读；
 * ② 前端截断是"按形态猜"，一旦 reason 文案变化就会静默失效。
 * 原始文本**不丢**：`/api/tutor` 在丢弃发生时记一条 `tutor.blocks.dropped` 日志，
 * 排查时仍能看到是哪个 refId 出的问题。
 *
 * ---
 *
 * **为什么单独成一个模块（2026-09-21，`W0-7①`）**
 *
 * 原先它是 `routes.ts` 里的**私有**函数，而 `routes.ts` 在**模块顶层**就 `Router()`
 * 建了路由表 —— 验证脚本一旦 import 它，会连 `express` 一起拉起，断言就跑不起来。
 * 为了能对"含未知 `refId` 的 reason 经改写后**不得出现 uuid**"下断言，
 * 把它提到这个**无副作用**的叶子模块并导出。
 *
 * ⚠️ 这是**有意识的接口改动，不是顺手导出**：它换来的是 `I35` 那条
 * "已登记断点"（带 id 的 reason 无断言覆盖）被真正关掉，见 `verify:guards` 的 `I35` 组。
 */

/** uuid 形态（含 v4 与其它版本），用于断言"内部标识不得漏给学生" */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 自检与断言共用的一条判据：文本里是否含 uuid */
export function containsUuid(text: string): boolean {
  return UUID_RE.test(text);
}

export function toStudentReason(reason: string): string {
  if (reason === 'AI 补充内容未经学生授权') return reason; // 本身无 id，可直接展示
  if (reason.startsWith('引用的来源不存在')) {
    return '回答引用了本次会话中不存在的来源，因此这一段没有展示';
  }
  if (reason.startsWith('引用了未经授权的补充块')) {
    return '回答引用了你尚未授权使用的补充内容，因此这一段没有展示';
  }
  if (reason.startsWith('摘录无法在来源中定位')) {
    return '回答的摘录无法在你提供的来源里定位，因此这一段没有展示';
  }
  return '有一段回答未通过来源校验，因此没有展示';
}

/**
 * 构造 `droppedBlocks` 字段（`I14`）。
 *
 * 契约规定：**有块通过时，其余被拒的块不得无声消失**（§4.3「不静默」）——
 * 原先只在"全部被拒"时报错，一旦有块通过，被拒块就从响应里消失了，
 * 学生看到的是一份残缺答案，却无从知道自己少看了一段。
 * **全部被拒时走 `throw`（403）**，因此本字段只在"部分被丢弃"时出现，
 * 没有丢弃时必须返回 `null`（而不是空对象）—— 否则契约上会多出一个恒存在的字段。
 *
 * 提取成纯函数的理由与 `toStudentReason` 相同（`W0-7②`）：让"部分通过"这条
 * **正面路径**能在不启动服务的前提下被断言（此前只有一条否定断言）。
 */
export function buildDroppedBlocks(
  rejected: { reason: string }[],
): { count: number; reasons: string[] } | null {
  if (rejected.length === 0) return null;
  return {
    count: rejected.length,
    // 原始原因（含内部 refId）只留在服务端日志里，这里一律换成学生话术
    reasons: [...new Set(rejected.map((item) => toStudentReason(item.reason)))],
  };
}
