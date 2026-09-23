/**
 * 练习提交 → 错题归因（`P-B9`，2026-09-23）
 *
 * 这个文件只做一件事：把「学生选了哪个选项」变成一条条**可核对的归因**，
 * 并把它们转成画像事件。归因的判据全在 `@lc/teaching` 的 `attribution.ts` 里，
 * 这里负责的是**取题**与**写画像**这两件服务端才有的事。
 *
 * ### 为什么在服务端做，而不是把归因下发给前端算
 *
 * 归因要用到**正确答案**与**干扰项上的错因标注**。这两样都在服务端：
 * - 判分依据不能由被评估方提供 —— 客户端若能自报"正确答案是什么"，归因就失去意义；
 * - 干扰项标注是题库的一部分（`FIXED_QUIZ`），按材料生成的题**没有**标注。
 *
 * 所以请求里只有 `itemId` + `selectedOptionId`（见契约 `QuizAttemptAnswer`），
 * 题面与答案一律由服务端按 `itemId` 反查。
 *
 * ### 只有自编题能被归因
 *
 * 按材料／变式生成的题**不在题库里**，服务端查不到 ⇒ 归因返回 `null` 并计入
 * `unattributed`。这是如实的结果：那类题既没有预标注，也不保证答案唯一可判。
 * **不为了让数字好看而给它们编一个错因**（§2.6）。
 */

import { FIXED_QUIZ, attributeQuizAttempt } from '@lc/teaching';
import type { ProfileEvent, QuizAttemptAnswer, QuizAttemptResult } from '@lc/contracts';

/** 题库里按 id 查题 —— 三个主题一张表，建立一次索引常驻 */
const ITEMS_BY_ID = new Map(
  Object.values(FIXED_QUIZ)
    .flat()
    .map((item) => [item.id, item] as const),
);

/**
 * 从**不受信任的请求体**里读出一条作答。
 *
 * 读不出形状就返回 `null`（调用方跳过该条）—— 不猜、不用默认值补。
 * 这里刻意不抛 400：作答列表里混进一条坏数据，不该让整次提交失败
 * （学生已经做完了题，丢掉整批归因才是更糟的结果）。
 */
export function readAttemptAnswer(raw: unknown): QuizAttemptAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { itemId, selectedOptionId } = raw as Record<string, unknown>;
  if (typeof itemId !== 'string' || itemId.length === 0) return null;
  if (typeof selectedOptionId !== 'string' || selectedOptionId.length === 0) return null;
  return { itemId, selectedOptionId };
}

/** 一条作答的归因结果 + 由它派生的画像事件（没有归因时事件为 `null`） */
export interface DerivedAttribution {
  result: QuizAttemptResult;
  event: ProfileEvent | null;
}

/**
 * 归因**单条**作答。
 *
 * 判分与归因**取自同一个来源**（服务端题库），因此不存在"判对了但归错了题"的错位。
 */
export function deriveAttribution(
  answer: QuizAttemptAnswer,
  sessionId: string,
  at: string,
): DerivedAttribution {
  const item = ITEMS_BY_ID.get(answer.itemId);

  /*
   * 题目不在自编题库里（按材料/变式生成的题）⇒ 归因不了。
   * 刻意**不**把 `correct` 猜成 `false`：判不了分就说判不了，
   * 由 `attribution: null` + `unattributed` 如实反映，而不是给一个假的对错。
   */
  if (!item) {
    return { result: { itemId: answer.itemId, correct: false, attribution: null }, event: null };
  }

  const correct = answer.selectedOptionId === item.answer;
  const attribution = attributeQuizAttempt({
    item,
    selectedOptionId: answer.selectedOptionId,
  });

  const event: ProfileEvent | null = attribution
    ? {
        type: 'quiz-attribution',
        sessionId,
        at,
        /*
         * 只送 `kind` + `pattern` —— 正好是 store 里「常见误区」的累计键（见
         * `commitProfileEvents` 的 `quiz-attribution` 分支）。
         * `reason` 不送：它是逐题的完整句子，进了画像只会让存储里堆一批
         * 各说各话的长句，而累计要的是一个稳定的短键。
         */
        payload: { kind: attribution.kind, pattern: attribution.pattern },
      }
    : null;

  return { result: { itemId: answer.itemId, correct, attribution }, event };
}
