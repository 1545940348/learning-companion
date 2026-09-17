/**
 * 接口请求与响应 —— 对应说明书 V2.0 §5.3「共享契约」（十个接口）
 *
 * 契约变更必须同步更新本文件、packages/contracts 使用方以及
 * `docs/tech/2026-09-17-契约迁移-V2.0-十接口与六态.md`。
 */

import type {
  GraphNeighborhood,
  KnowledgeResult,
  PrerequisiteStatus,
  VerificationStatus,
} from './knowledge.js';
import type { LowConfidenceSpan, Material } from './session.js';
import type { QuizItem, QuizSource, Topic } from './quiz.js';
import type { ProfileRequest, ProfileResponse, TeacherResponse } from './profile.js';

/* ============ 统一错误 ============ */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  /** 会话或材料版本不匹配：旧请求结果应被丢弃（说明书 5.4） */
  | 'SESSION_STALE'
  /** 未经授权的外部内容：不得作为正常答案展示（用例 E7） */
  | 'UNAUTHORIZED_CONTENT'
  /** 超过请求总预算，可重试并保留输入（说明书 5.4） */
  | 'MODEL_TIMEOUT'
  | 'MODEL_ERROR'
  /**
   * 该接口属于后续阶段、当前版本未实现。
   *
   * 与 `NOT_FOUND` 分开的理由：`NOT_FOUND` 表示"路径/资源不存在"，这里是
   * **路径存在但功能未交付**。混用会让前端无法区分"接口写错了"与"功能还没做"，
   * 也会掩盖"以空数据冒充已实现"的问题（§9）。
   */
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
  };
}

/* ============ POST /api/session ============ */

/* 响应即 Session（见 session.ts），materialVersion=0、graph 为空图谱 */

/* ============ GET /api/health ============ */

/** 验证引擎状态（V2.0 §5.2 要求 health 如实报告通道与验证引擎） */
export interface VerificationEngineStatus {
  /** 引擎名，如 `mathjs` */
  engine: string;
  /** 是否可用；未接入时为 false，**不得伪报 true** */
  available: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  modelProvider: string;
  /** 为 true 表示当前使用 mock 适配器，未接真实模型 */
  mock: boolean;
  verification: VerificationEngineStatus;
}

/* ============ POST /api/parse ============ */

export interface ParseRequest {
  text?: string;
  /** data URL 或 base64；不长期保存（说明书 2.2） */
  imageBase64?: string;
  /** 语音 data URL 或 base64；≤ MAX_VOICE_SECONDS 秒（说明书 2.2） */
  audioBase64?: string;
}

/** 公式识别结果：输出 LaTeX 并保留符号语义，供符号验证使用（§2.2） */
export interface FormulaSpan {
  /** 在 text 中的起止位置 */
  start: number;
  end: number;
  latex: string;
}

/** 图像理解的结构化描述：图表类型、坐标轴、关键点、趋势（§2.2） */
export interface ImageStructure {
  chartType?: string;
  axes?: { x?: string; y?: string };
  keyPoints?: { label: string; x?: number; y?: number }[];
  trend?: string;
  /** 无刻度示意图**不据此估算精确数值**（§2.2）；为 true 时不得填写数值型 keyPoints */
  notToScale?: boolean;
}

/** 语音转写片段：保留时间戳以便溯源（§2.2） */
export interface TranscriptSpan {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ParseResponse {
  /** 识别文本。默认可直接使用，不设确认阻断步骤（§2.2） */
  text: string;
  /** 识别出的公式，供符号验证使用 */
  formulas?: FormulaSpan[];
  /** 图片内容的文本描述 */
  imageDescription?: string;
  /** 图片的结构化理解 */
  imageStructure?: ImageStructure;
  /** 语音转写片段（含时间戳） */
  transcript?: TranscriptSpan[];
  /** 低置信度片段，仅作提示 */
  lowConfidence: LowConfidenceSpan[];
  /**
   * 本次未接入、因而**无法提供**的识别通道，如 `['image']`、`['audio']`。
   *
   * 说明书 §9 要求「不以模拟行为冒充真实能力」：未接入时如实报告，
   * 不得返回「【占位】已接收」这类会被误读为已解析的描述。
   */
  unavailable?: ('image' | 'audio' | 'formula')[];
}

/* ============ POST /api/knowledge ============ */

export interface KnowledgeRequest {
  sessionId: string;
  materials: Material[];
}

/** 响应即 KnowledgeResult（含落盘后的图谱快照） */
export type KnowledgeResponse = KnowledgeResult;

/* ============ GET /api/graph ============ */

export interface GraphQuery {
  sessionId: string;
  /** 中心知识点；省略则返回会话图谱全量（说明书 §2.3 图谱视图） */
  knowledgePointId?: string;
}

export type GraphResponse = GraphNeighborhood;

/* ============ POST /api/gap ============ */

export interface GapRequest {
  sessionId: string;
  materialVersion: number;
  /** 缺口概念 ID */
  conceptId: string;
  /** 缺口理由，来自前置关系的 reason */
  reason: string;
}

export interface GapResponse {
  /** 最小必要补充内容（200—400 字），须显著标注为 AI 补充 */
  content: string;
  /** 新增的补充块 ID；服务端以此校验跨会话引用 */
  supplementBlockId: string;
  /** 更新后的依赖状态：MISSING → SUPPLEMENTED →（验证通过）VERIFIED */
  status: PrerequisiteStatus;
  /** 补充内容的验证状态；未验证时不得默认视为正确（§4.2） */
  verification: VerificationStatus;
  /** 递增后的材料版本 */
  materialVersion: number;
}

/* ============ POST /api/quiz ============ */

/**
 * ⚠️ V2.0 由 `GET /api/quiz?topic=&source=` 改为 `POST`。
 *
 * 变更原因：会话上下文与来源类型改为随 body 提交，避免长 query 与
 * 中文主题在 URL 中的编码问题。**属破坏性变更**，A 侧调用须同批改造。
 */
export interface QuizRequest {
  topic: Topic;
  source: QuizSource;
  /** source 为 'material' 时必填 */
  sessionId?: string;
}

export interface QuizResponse {
  items: QuizItem[];
}

/* ============ POST /api/profile ============ */

export type { ProfileRequest, ProfileResponse };

/* ============ GET /api/teacher ============ */

export type { TeacherResponse };

export interface TeacherQuery {
  classId: string;
}
