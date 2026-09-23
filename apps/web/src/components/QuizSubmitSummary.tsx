/**
 * 练习提交后那行小结（`P-B9`，2026-09-23）
 *
 * 从 `QuizPanel.tsx` 拆出来，理由与 `WrongAnswerAttribution` 一样：
 * ① 这是**无据声明**的高发地 —— 上一版在这里写死了「已作为一条画像事件上报」，
 *    而默认自编题路径**根本不发请求**（`I33`）。四种状态各有各的实话，
 *    独立成组件后 `verify:render` 能把每一种都渲染一遍，而不是只看得到默认那种；
 * ② `QuizPanel.tsx` 需要腾出体积（`I43` 的 300 行闸门）。
 *
 * ### 四种状态，一句都不能串
 *
 * | `outcome` | 实话 |
 * |---|---|
 * | `'sent'` | 上报成功；并如实报出**归因了几道、几道推不出来** |
 * | `'no-session'` | **没有发出任何请求**（自编题不需要会话）—— 不是"上报成功" |
 * | `'failed'` | 发过请求但失败；**不影响判分** |
 * | `null` | 还在上报中 —— 不是结论 |
 *
 * 「几道推不出来」由**服务端**的 `unattributed` 给出，不由前端数：
 * 前端只看到 `attribution === null`，分不清"答对了"与"推不出"。
 */

import type { QuizReport } from '../app/model/workbench-types';

export function QuizSubmitSummary({
  report,
  correct,
  total,
}: {
  report: QuizReport | null;
  correct: number;
  total: number;
}) {
  const wrong = total - correct;
  /* 服务端数好的"答错但推不出"条数；`report` 未回来时谈不上 */
  const unattributed = report?.unattributed ?? 0;

  return (
    <p className="hint-inline">
      {report?.outcome === 'sent' && (
        <>
          本次提交已作为一条画像事件上报（答对 {correct} / {total}）。
          {wrong > 0 &&
            (unattributed === 0 ? (
              <>
                本次 {wrong} 道错题都给出了可核对的归因，已计入画像的「常见误区」。
              </>
            ) : (
              <>
                本次 {wrong} 道错题中，{wrong - unattributed} 道给出了可核对的归因；
                另有 {unattributed} 道**推不出**归因（按材料生成的题没有预先标注，
                系统不靠"答错"猜原因）。
              </>
            ))}
        </>
      )}
      {report?.outcome === 'no-session' && (
        <>
          本次提交「没有」上报画像事件：这一组是「项目自编题」，它不需要学习会话，
          因此没有发出任何请求（答对 {correct} / {total}）。
        </>
      )}
      {report?.outcome === 'failed' && (
        <>
          本次提交的画像事件上报失败，画像可能未更新（不影响你的作答与判分：
          答对 {correct} / {total}）。
        </>
      )}
      {report === null && <>正在上报本次作答（答对 {correct} / {total}）…</>}
    </p>
  );
}
