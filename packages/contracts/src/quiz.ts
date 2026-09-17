/**
 * 练习 —— 对应说明书 2.6
 *
 * 两组题：固定题（兜底、可校验）与按材料生成题（贴合学生材料）。
 */

import type { Citation, VerificationStatus } from './knowledge.js';

/** 课程范围严格限定为三个主题 */
export type Topic = 'derivative' | 'tangent' | 'monotonicity';

export const TOPIC_LABELS: Record<Topic, string> = {
  derivative: '导数',
  tangent: '切线',
  monotonicity: '单调性',
};

/**
 * 题目来源
 * - fixed    项目自编固定题，须标注身份，不能伪装成上传讲义原题
 * - material 基于当前会话材料生成，属来源类别 ②
 */
export type QuizSource = 'fixed' | 'material';

export interface QuizOption {
  id: string;
  text: string;
}

export interface QuizItem {
  id: string;
  topic: Topic;
  source: QuizSource;
  stem: string;
  options: QuizOption[];
  /** 仅在学生提交后由前端展示（说明书 2.6） */
  answer?: string;
  explanation?: string;
  /** 解析所用规则的依据 */
  citations?: Citation[];
  /**
   * 验证状态（V2.0 §5.3：练习输出含验证状态）。
   * 固定题由服务端标为 `human`（自编题经人工核验）；
   * 按材料生成的题缺省 `unverified`，不得默认视为正确。
   */
  verification?: VerificationStatus;
}

/** 固定题每题主题的道数（说明书 2.6） */
export const FIXED_QUIZ_PER_TOPIC = 3;

/** 按材料生成题的道数 */
export const MATERIAL_QUIZ_PER_TOPIC = 2;
