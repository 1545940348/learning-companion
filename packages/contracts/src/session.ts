/**
 * 会话与材料 —— 对应说明书 5.2 共享类型、5.3 会话与错误处理
 *
 * 设计要点：
 * - 轻路径（零材料提问）的 materialVersion 为 0，materials 为空数组
 * - AI 补充块与用户上传材料**分开存储**，来源才不会混同（说明书 4.2）
 */

/** 材料的来源类型 */
export type MaterialKind = 'upload' | 'ai-supplement';

/** 识别置信度偏低的片段。仅作提示，不阻断使用（说明书 2.2） */
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
 * **仅在其所属会话内有效，不得跨会话引用**（说明书 4.2、用例 E10）。
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
}

export interface Session {
  id: string;
  /** 材料版本，每次材料或补充块变化后递增；轻路径会话为 0 */
  materialVersion: number;
  materials: Material[];
  supplements: SupplementBlock[];
  createdAt: string;
  updatedAt: string;
}

/** 素材上限，超出时提示缩短或开始新学习（说明书 2.2） */
export const MATERIAL_LIMITS = {
  maxMaterialsPerSession: 3,
  maxTextLength: 9000,
  maxSingleInputLength: 3000,
  maxImageBytes: 5 * 1024 * 1024,
} as const;

/** 模型请求超时（毫秒），对应说明书 5.3 的 60 秒约束 */
export const MODEL_TIMEOUT_MS = 60_000;
