/**
 * 提示（`Notice`）的呈现规则 —— 纯函数，无 React、无副作用。
 *
 * ### 为什么从 `hooks/useWorkbench.ts` 搬出来（2026-09-23）
 *
 * 外壳组件（`components/AppShell.tsx`）也要用这条判据，而 `components → hooks`
 * 的依赖方向被 `panels-should-not-import-state-internals` 禁止 ——
 * 与其在组件里重写一遍（两处逻辑必然漂移），不如把判据放到分层正确的 model 层。
 * 「重试按钮挂在哪条提示上」这种规则一旦写两遍，早晚会出现一处改了、另一处没改。
 */

import type { Notice } from './workbench-types';

/**
 * 是否展示「重试」按钮（`I20⑤`）。
 *
 * 两个条件**缺一不可**：
 * 1. `canRetry` —— 上一次动作确实失败过（否则没有可重放的动作）；
 * 2. 当前这条提示本身带 `retryable` —— 它是服务端标为可重试的那次失败。
 *
 * 只有第 1 条时，任何一条普通提示（"已按修正后的内容重建…"，
 * 甚至"上一个操作还没完成"这种**并非失败**的提示）都会被挂上「重试」，
 * 点下去重放的是与它无关的旧动作。抽成纯函数是为了让这条语义能被断言，
 * 而不是只靠读代码确认。
 */
export function shouldOfferRetry(notice: Notice | null, canRetry: boolean): boolean {
  return canRetry && notice?.retryable === true;
}
