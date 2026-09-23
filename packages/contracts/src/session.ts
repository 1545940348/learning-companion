/**
 * 会话与材料 —— 对应说明书 5.3、5.4 会话与错误处理
 *
 * 设计要点：
 * - 轻路径（零材料提问）的 materialVersion 为 0，materials 为空数组
 * - AI 补充块与用户上传材料**分开存储**，来源才不会混同（§4.2）
 * - 图谱随材料一并原子提交并计入同一个 materialVersion（§3.3）
 */

import type { SessionGraph, VerificationStatus } from './knowledge.js';

/** 材料的来源类型 */
export type MaterialKind = 'upload' | 'ai-supplement';

/** 识别置信度偏低的片段。仅作提示，不阻断使用（§2.2） */
export interface LowConfidenceSpan {
  /** 在 text 中的起止位置 */
  start: number;
  end: number;
  reason: string;
}

/** 一份材料。图片解析为文本／描述后以 kind='upload' 入库 */
export interface Material {
  id: string;
  kind: MaterialKind;
  /** 识别或粘贴得到的文本；图片材料为其文本描述 */
  text: string;
  lowConfidence?: LowConfidenceSpan[];
  createdAt: string;
}

/**
 * AI 按需补充块。
 * 由学生点击「补上这一段」授权生成，带有 authorizedAt 作为授权凭据；
 * **仅在其所属会话内有效，不得跨会话引用**（§4.2、用例 E10）。
 */
export interface SupplementBlock {
  id: string;
  /** 归属会话，服务端据此校验跨会话引用 */
  sessionId: string;
  /** 被补齐的前置概念 ID */
  conceptId: string;
  content: string;
  /** 生成并授权的时间，证明非静默生成 */
  authorizedAt: string;
  /** 补充内容的验证状态；缺省视为 `unverified`（§4.2） */
  verification?: VerificationStatus;
}

export interface Session {
  id: string;
  /** 材料版本，每次材料／图谱／补充块变化后递增；轻路径会话为 0 */
  materialVersion: number;
  materials: Material[];
  supplements: SupplementBlock[];
  /**
   * 图谱快照。与材料在同一次原子提交中写入（§3.3），
   * `GET /api/graph` 与前端图谱视图均从此读取。
   */
  graph: SessionGraph;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一个会话的**摘要** —— `GET /api/sessions` 的列表元素（2026-09-23 新增，**加性**）。
 *
 * ### 为什么不直接返回 `Session`
 *
 * 列表要回答的是"**有哪些会话**"，不是"这些会话里都写了什么"。
 * 直接回 `Session` 会把**讲义原文**、图谱与补充块正文一并吐出来 ——
 * 列表页不需要它们，而它们恰恰是最该少传的内容。
 * 所以这里**只列元信息**，正文留在各自的详情接口（`GET /api/graph` 等）。
 */
export interface SessionSummary {
  /** 会话 ID（`POST /api/session` 返回的那个） */
  id: string;
  createdAt: string;
  /** 最后一次变更时间；列表按它**倒序** */
  updatedAt: string;
  materialVersion: number;
  /**
   * **学生自己提交的**材料份数（不含 AI 补充块 —— 补充块存在 `supplements` 里，两者分开存）。
   * 轻路径会话为 `0`。
   */
  materialCount: number;
}

/** 素材上限，超出时提示缩短或开始新学习（说明书 V2.0 §2.2：5 份 / 15000 字） */
export const MATERIAL_LIMITS = {
  maxMaterialsPerSession: 5,
  maxTextLength: 15000,
  maxSingleInputLength: 3000,
  maxImageBytes: 5 * 1024 * 1024,
} as const;

/** 单段语音最长秒数（说明书 V2.0 §2.2） */
export const MAX_VOICE_SECONDS = 60;

/**
 * 单次业务请求的总预算（毫秒）。
 *
 * 说明书 V2.0 §5.2 为 **90 秒**（含符号验证），且**重试计入同一预算** ——
 * 不是"每次尝试 90 秒"。由 `model/budget.ts` 的 `createBudget` 保证同一预算被多次尝试共享。
 */
export const MODEL_TIMEOUT_MS = 90_000;
