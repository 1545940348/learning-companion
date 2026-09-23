/**
 * 多智能体协作与降级 —— 对应说明书 §4.5、用例 E18（`P-B8`，2026-09-23）
 *
 * ### 为什么这些类型放在契约里，而不是只留在 `@lc/teaching`
 *
 * 降级记录要**穿过接口**到达界面：服务端产出它，响应体带着它，面板显示它。
 * 三处都要认得同一个形状 —— 若只在教学包内部定义、由服务端各写一份，
 * 就会出现"契约说三个字段、实现给了四个"的漂移，而这种漂移是**静默**的
 * （多出来的字段没人读，少掉的字段没人报错）。
 *
 * `@lc/teaching` 从本包引入并原样再导出（依赖方向：teaching → contracts，
 * 与 `MisconceptionKind` 等既有类型一致，**不构成循环依赖**）。
 */

/** 四个 Agent 的角色名（与说明书 §4.5 的表一一对应） */
export type AgentRole = 'tutor' | 'verifier' | 'diagnoser' | 'quizzer';

/** 面向学生的角色称呼 —— 界面直接引用，避免各处各写一份 */
export const AGENT_LABELS: Record<AgentRole, string> = {
  tutor: '答疑',
  verifier: '验证',
  diagnoser: '诊断',
  quizzer: '出题',
};

/**
 * 一条降级记录（E18：「任一 Agent 失败不影响主流程并**如实标注**」）。
 *
 * `fallback` 写的是**实际发生了什么**，不是"已降级"这种话 ——
 * 学生要能据此判断"这次的答案还差什么"。
 */
export interface AgentDegradation {
  agent: AgentRole;
  /** 哪个 Agent 没跑成（固定句子，**不含**上游报错原文） */
  reason: string;
  /** 降级后实际发生了什么 */
  fallback: string;
}
