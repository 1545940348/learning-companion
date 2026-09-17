/**
 * 学习画像与教师视图 —— 对应说明书 §2.1、§2.6、§5.3、§11
 *
 * 边界：
 * - 画像事件跨会话保留（P1），但 **AI 补充内容不迁移**（§3.4、用例 E16）
 * - 教师视图**只读且脱敏**：只输出计数与概念维度统计，不含学生标识与原始提问（用例 E17）
 */

import type { PrerequisiteStatus } from './knowledge.js';

/**
 * 画像事件类型。
 *
 * 轻路径也产生画像事件（§2.1）：问题主题、是否含公式、是否含图像。
 */
export type ProfileEventType =
  /** 提问；轻路径同样产生 */
  | 'question-asked'
  /** 缺口已补充（MISSING → SUPPLEMENTED） */
  | 'gap-supplemented'
  /**
   * 学生选择「我已掌握，继续」。
   * 只影响引导，**不改变材料覆盖状态**（§2.3），但写入画像。
   */
  | 'gap-claimed-known'
  /** 提交练习 */
  | 'quiz-attempted'
  /** 错题归因（§2.6）：概念误解／计算错误／条件遗漏／识别错误 */
  | 'quiz-attribution';

/** 错题归因分类（§2.6，P1） */
export type MisconceptionKind =
  | 'concept-misunderstanding'
  | 'calculation-error'
  | 'condition-omission'
  | 'recognition-error';

export interface ProfileEvent {
  type: ProfileEventType;
  sessionId: string;
  conceptId?: string;
  /** 事件发生时间（ISO 8601） */
  at: string;
  /** 事件载荷：如 question-asked 的 { topic, hasFormula, hasImage } */
  payload?: Record<string, unknown>;
}

/** `POST /api/profile` 请求：提交事件，取回更新后的画像（§5.3） */
export interface ProfileRequest {
  sessionId: string;
  events: ProfileEvent[];
}

export interface LearnerProfile {
  sessionId: string;
  /** 概念 → 掌握状态；与图谱六态同源 */
  mastery: Record<string, PrerequisiteStatus>;
  /** 缺口历史；resolvedAt 为补齐时间 */
  gaps: { conceptId: string; resolvedAt?: string }[];
  /** 常见误区累计 */
  misconceptions: { kind: MisconceptionKind; pattern: string; count: number }[];
  updatedAt: string;
}

/** `POST /api/profile` 响应 */
export type ProfileResponse = LearnerProfile;

/* ============ 教师视图（P1，阶段三） ============ */

/**
 * 班级聚合。**只含计数与概念维度统计**，不含个人信息（用例 E17）。
 */
export interface ClassAggregate {
  classId: string;
  /** 样本量；不足时前端须提示「样本不足」，不生成误导性结论 */
  studentCount: number;
  /** 概念 → 各状态人数分布 */
  mastery: Record<string, Record<PrerequisiteStatus, number>>;
  /** 常见误区排行 */
  misconceptions: { kind: MisconceptionKind; pattern: string; count: number }[];
  /** 材料覆盖热力图：某材料是否覆盖某概念 */
  coverageHeat: { materialId: string; conceptId: string; covered: boolean }[];
  updatedAt: string;
}

export type TeacherResponse = ClassAggregate;

/** 样本量低于此值时前端应提示「样本不足」（§11 教师视图边界） */
export const TEACHER_MIN_SAMPLE = 5;
