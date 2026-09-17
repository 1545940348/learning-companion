/**
 * 知识点、前置依赖与图谱 —— 对应说明书第 03 章
 *
 * 依赖六态与三类来源是本项目的核心机制；图谱由概念层节点与关系边构成。
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
 * 前置依赖六态（说明书 V2.0 §3.2）
 * - LOCAL        材料已覆盖：任一材料中有足以支持当前学习目的的说明，且能定位来源
 * - SUPPLEMENTED 已由 AI 补充：材料原本缺失，经学生点击后由系统补齐
 * - MISSING      材料未覆盖：当前学习明确需要，所有材料均无解释，尚未补充
 * - PENDING      待确认：依据不清晰或公式识别不完整
 * - VERIFIED     已验证：补充或推导通过符号验证或人工核验
 * - DISPUTED     有争议：验证失败或来源冲突，需人工介入
 *
 * 硬规则（§3.4，代码与回归脚本须同时体现）：
 * - `SUPPLEMENTED → VERIFIED` 仅当验证状态为 `symbolic` 或 `human`
 * - 验证 `failed` 时 `SUPPLEMENTED → DISPUTED`
 * - `SUPPLEMENTED` **不因学生表示「已会」转为 `LOCAL`**
 * - `MISSING → LOCAL` 仅当新增材料**确实提供说明**（仅提及不算）
 * - 补充内容不跨会话迁移；新会话中同一概念回到 `MISSING`
 */
export type PrerequisiteStatus =
  | 'LOCAL'
  | 'SUPPLEMENTED'
  | 'MISSING'
  | 'PENDING'
  | 'VERIFIED'
  | 'DISPUTED';

/**
 * 验证状态（说明书 V2.0 §2.5、§4.4）
 * - symbolic   已符号验证
 * - human      已人工核验
 * - unverified 未验证（含验证超时；如实展示，不阻断答疑）
 * - failed     验证未通过 → 触发修正回环或人工介入
 */
export type VerificationStatus = 'symbolic' | 'human' | 'unverified' | 'failed';

/**
 * 未提供验证结果时的默认值。
 *
 * 取 `unverified` 而非 `symbolic`：§4.2 要求「补充内容必须经过符号验证或标记为未验证，
 * 不得默认视为正确」，因此缺省必须落在"未验证"一侧。
 */
export const DEFAULT_VERIFICATION: VerificationStatus = 'unverified';

/** 判定通过（可用于 SUPPLEMENTED → VERIFIED 的迁移） */
export const VERIFYING_STATUSES: readonly VerificationStatus[] = ['symbolic', 'human'];

export interface PrerequisiteRelation {
  /** 前置概念 ID（稳定编号，重建时保持不变） */
  conceptId: string;
  conceptName: string;
  status: PrerequisiteStatus;
  /** 为什么判定它是前置知识；仅出现术语不足以证明（§3.1） */
  reason: string;
  /** 支撑依据：LOCAL 指向材料，SUPPLEMENTED 指向补充块 */
  evidence: Citation[];
  /** 该关系的验证状态（§3.4：每条前置关系都含验证状态） */
  verification: VerificationStatus;
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
  /** 验证状态（§2.3 卡片需可展开验证状态） */
  verification: VerificationStatus;
}

/* ============ 图谱（说明书 §3.1、§3.3） ============ */

/**
 * 关系类型（§3.1）。
 * 初赛以 `prerequisite` 为核心，其余关系用于答疑与出题。
 */
export type RelationKind =
  /** 学习当前知识点前需要了解 */
  | 'prerequisite'
  /** 可由前置推导 */
  | 'derives'
  /** 例证 */
  | 'illustrates'
  /** 对比／易混 */
  | 'contrasts'
  /** 推广／特例 */
  | 'extends'
  /** 计算或证明依赖 */
  | 'depends_on';

/**
 * 概念层节点即为知识点（§3.1 概念层：ID、名称、定义、公式、条件、误区）。
 * 用别名而非独立接口，避免同一结构两处定义、两处漂移。
 */
export type GraphNode = KnowledgePoint;

/** 概念层关系边 */
export interface GraphEdge {
  /** 依赖方（当前知识点 ID） */
  from: string;
  /** 被依赖方（前置知识点 ID） */
  to: string;
  kind: RelationKind;
  status: PrerequisiteStatus;
  reason: string;
  evidence: Citation[];
  /** 由多跳推理补全的隐含关系标为「推断」（§3.3 增强阶段） */
  inferred?: boolean;
  verification: VerificationStatus;
}

/**
 * 图谱快照。
 *
 * 由 `/api/knowledge` **与材料同一次原子提交**写入会话（§3.3 步骤 5「整体提交新版本」），
 * 否则 `/api/graph` 无数据可读。
 */
export interface SessionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const EMPTY_GRAPH: SessionGraph = { nodes: [], edges: [] };

/** `GET /api/graph` 的响应：以某个知识点为中心的邻域（§2.3 图谱视图） */
export interface GraphNeighborhood {
  sessionId: string;
  materialVersion: number;
  /** 中心知识点；为空表示返回会话图谱全量 */
  rootConceptId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface KnowledgeResult {
  sessionId: string;
  materialVersion: number;
  /** 展示数量；依赖覆盖判定仍检查全部材料（§2.3） */
  points: KnowledgePoint[];
  prerequisites: PrerequisiteRelation[];
  /** 落盘后的图谱快照，便于前端一次拿到邻域数据 */
  graph: SessionGraph;
}

/** 展示的知识点卡片数量区间（说明书 2.3） */
export const KNOWLEDGE_CARD_RANGE = { min: 3, max: 6 } as const;

/** 缺口补充内容的目标长度区间（说明书 2.3） */
export const SUPPLEMENT_LENGTH = { min: 200, max: 400 } as const;
