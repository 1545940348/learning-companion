/**
 * 知识点与前置依赖 —— 对应说明书第 03 章
 *
 * 依赖四态是本项目的核心机制；三类来源贯穿全部教学内容块。
 */

/** 三类教学来源（说明书 4.3） */
export type SourceType =
  /** ① 来自讲义：引用编号有效，摘录可在对应材料中找到 */
  | 'material'
  /** ② 根据讲义解释／推导：绑定支持规则或片段 */
  | 'derived'
  /** ③ AI 补充／外部内容：仅经学生按需授权后生成 */
  | 'ai-supplement';

/** 可定位的引用 */
export interface Citation {
  sourceType: SourceType;
  /** 材料 ID 或补充块 ID */
  refId: string;
  /** 可在对应来源中定位到的摘录 */
  excerpt: string;
}

/**
 * 前置依赖四态（说明书 3.1）
 * - LOCAL        材料已覆盖
 * - SUPPLEMENTED 已由 AI 补充（区别于讲义来源，必须独立标记）
 * - MISSING      材料未覆盖，尚未补充
 * - PENDING      待确认：依据不清晰或识别不完整
 */
export type PrerequisiteStatus = 'LOCAL' | 'SUPPLEMENTED' | 'MISSING' | 'PENDING';

export interface PrerequisiteRelation {
  /** 前置概念 ID（稳定编号，重建时保持不变） */
  conceptId: string;
  conceptName: string;
  status: PrerequisiteStatus;
  /** 为什么判定它是前置知识；仅出现术语不足以证明（说明书 3.1） */
  reason: string;
  /** 支撑依据：LOCAL 指向材料，SUPPLEMENTED 指向补充块 */
  evidence: Citation[];
}

export interface KnowledgePoint {
  id: string;
  name: string;
  explanation: string;
  /** 公式与适用条件 */
  formula?: string;
  conditions?: string;
  /** 常见误区 */
  misconceptions?: string[];
  citations: Citation[];
}

export interface KnowledgeResult {
  sessionId: string;
  materialVersion: number;
  /** 展示数量；依赖覆盖判定仍检查全部材料（说明书 2.3） */
  points: KnowledgePoint[];
  prerequisites: PrerequisiteRelation[];
}

/** 展示的知识点卡片数量区间（说明书 2.3） */
export const KNOWLEDGE_CARD_RANGE = { min: 3, max: 6 } as const;

/** 缺口补充内容的目标长度区间（说明书 2.3） */
export const SUPPLEMENT_LENGTH = { min: 200, max: 400 } as const;
