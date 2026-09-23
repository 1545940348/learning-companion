/**
 * 材料的纯函数工具 —— 无 React、无网络、无副作用。
 *
 * ### 为什么独立成文件（2026-09-23 解耦改造）
 *
 * `totalTextLength` 原先住在 `hooks/useWorkbench.ts`，而 `MaterialPanel` 需要它，
 * 于是面板 → hooks 的依赖触发了 `panels-should-not-import-state-internals`
 * （presentation → state internals，方向与分层相反）。
 *
 * 判据很简单：**能脱离 hook 独立存在的计算属于 model 层，不属于状态层**。
 * 放在这里之后，面板引用它不再穿透到 hooks，规则清零并可转 `error`。
 */

/** 材料文本合计，用于上限提示（§2.2） */
export function totalTextLength(materials: { text: string }[]): number {
  return materials.reduce((sum, item) => sum + item.text.length, 0);
}
