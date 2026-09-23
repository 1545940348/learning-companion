/**
 * 错题下面那块归因（`P-B9`，2026-09-23）
 *
 * 从 `QuizPanel.tsx` 单独拆出来，有两个实际理由：
 * ① 它是**真实性红线**最容易失守的一段文案（`null` 有两种来路，说错就是说错），
 *    独立成组件后 `verify:render` 能**直接**把三种分支各渲染一遍 ——
 *    留在面板内部就只能靠"点一下提交"才看得到，而 SSR 点不了；
 * ② `QuizPanel.tsx` 已接近 300 行的体积闸门（`I43`），拆出来两不耽误。
 *
 * ### 显示的三样东西，以及为什么是这三样
 *
 * 1. **类别**（概念误解／计算错误／条件遗漏／识别错误）—— 一句话说清"这是哪一类问题"；
 * 2. **理由** —— 由出题人写下的、指明具体一处的那句（不是"理解不到位"这类没法判的话）；
 * 3. **核对材料** —— 你选的原文 vs 正确的原文。
 *
 * 第 3 样是**关键**：§2.6 的红线是"不得仅凭答案对错断言"。把两侧原文摆出来，
 * 学生不必相信这个结论 —— 他可以自己比一遍。少了它，前两样就只是"系统说的"。
 */

import type { QuizAttribution } from '@lc/contracts';
import { MISCONCEPTION_LABELS } from '../shared/lib/labels';

export function WrongAnswerAttribution({
  attribution,
  settled,
}: {
  attribution: QuizAttribution | null;
  /**
   * 提交是否**已经有结论**（服务端已回应）。
   *
   * 这个参数存在的唯一目的，是把 `attribution === null` 的两种来路分开：
   * 没结论时说"正在核对"，有结论还说 `null` 才是"推不出来"。
   * 少了它，界面会把"还没拿到"写成"推不出原因"—— 一秒钟之内是真的，一秒之后是假的。
   */
  settled: boolean;
}) {
  if (!attribution) {
    return (
      <p className="hint-inline">
        {settled
          ? '这次错因没有给出归因：系统只在能给出可核对的依据时才下结论（自编题的干扰项有预先标注，按材料生成的题没有）。仅凭"答错"推断原因会是编造。'
          : '正在核对这次的错因…'}
      </p>
    );
  }

  return (
    <div className="quiz-attribution">
      <p className="quiz-attribution-head">
        错因归因：<span className="tag tag-muted">{MISCONCEPTION_LABELS[attribution.kind]}</span>
      </p>
      <p className="quiz-attribution-reason">{attribution.reason}</p>
      <p className="hint-inline">
        你可以自己核对：你选了「{attribution.evidence.selectedText}」，正确选项是「
        {attribution.evidence.correctText}」。
      </p>
    </div>
  );
}
