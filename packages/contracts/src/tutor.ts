/**
 * 答疑 —— 对应说明书 2.5、第 04 章
 */

import type { Citation, SourceType, VerificationStatus } from './knowledge.js';

/** 三种辅导模式；默认先给提示，完整解答由学生主动选择（说明书 2.5） */
export type TutorMode = 'explain' | 'hint' | 'full';

/** 边界判定结果（说明书 4.1） */
export type AnswerScope =
  /** 材料明确包含 */
  | 'in-material'
  /** 可依据材料推导：允许新例题与计算 */
  | 'derivable'
  /** 缺少前置知识：说明缺什么，同屏提供补上这一段 */
  | 'missing-prereq'
  /** 部分支持：可答部分与不足部分分开说明 */
  | 'partial'
  /** 超出课程范围：引导回到导数／切线／单调性 */
  | 'out-of-scope'
  /** 题目条件不足：先澄清，不混同于缺少知识素材 */
  | 'insufficient-question';

export interface RecentAnswer {
  question: string;
  answer: string;
}

export interface TutorRequest {
  /** 为空表示轻路径（零材料）提问 */
  sessionId: string | null;
  /** 轻路径为 0 */
  materialVersion: number;
  question: string;
  /** 当前聚焦的知识点，可选 */
  knowledgePointId?: string;
  mode: TutorMode;
  /** 有限历史，避免无界上下文 */
  recentAnswers?: RecentAnswer[];
}

export interface AnswerBlock {
  content: string;
  sourceType: SourceType;
  citations: Citation[];
  /**
   * 验证状态（V2.0 §2.5：依据详情须含验证状态）。
   *
   * 响应中**必有值**：模型未提供时由服务端归一化为 `unverified`，
   * 不把「没验证」伪装成「已验证」（§4.2）。
   */
  verification: VerificationStatus;
}

/** 下一步建议 */
export interface NextStep {
  kind: 'supplement-gap' | 'continue' | 'clarify' | 'back-to-topic';
  message: string;
  /** kind 为 'supplement-gap' 时给出缺口概念 ID */
  conceptId?: string;
}

export interface TutorResponse {
  scope: AnswerScope;
  /** 分块回答；片段与来源一一对应 */
  blocks: AnswerBlock[];
  /** 是否基于学生材料作答；轻路径为 false */
  basedOnMaterial: boolean;
  nextStep?: NextStep;
}

/** 校验通过的回答块。B 负责结构、编号与摘录匹配校验（说明书 4.3） */
export interface ValidatedAnswer {
  valid: AnswerBlock[];
  /** 校验失败被拒的块；不得作为正常答案展示（用例 E7） */
  rejected: { block: AnswerBlock; reason: string }[];
}
