/**
 * 接口请求与响应 —— 对应说明书 5.2「首日冻结的契约」
 *
 * 契约变更必须同步更新本文件、packages/contracts 使用方以及 docs/tech 记录。
 */

import type { KnowledgeResult, PrerequisiteStatus } from './knowledge.js';
import type { LowConfidenceSpan, Material } from './session.js';
import type { QuizItem, QuizSource, Topic } from './quiz.js';

/* ============ 统一错误 ============ */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  /** 会话或材料版本不匹配：旧请求结果应被丢弃（说明书 5.3） */
  | 'SESSION_STALE'
  /** 未经授权的外部内容：不得作为正常答案展示（用例 E7） */
  | 'UNAUTHORIZED_CONTENT'
  /** 超过 60 秒，可重试并保留输入（说明书 5.3） */
  | 'MODEL_TIMEOUT'
  | 'MODEL_ERROR'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
  };
}

/* ============ POST /api/parse ============ */

export interface ParseRequest {
  text?: string;
  /** data URL 或 base64；不长期保存（说明书 2.2） */
  imageBase64?: string;
}

export interface ParseResponse {
  /** 识别文本。默认可直接使用，不设确认阻断步骤 */
  text: string;
  /** 图片内容的文本描述 */
  imageDescription?: string;
  /** 低置信度片段，仅作提示 */
  lowConfidence: LowConfidenceSpan[];
}

/* ============ POST /api/knowledge ============ */

export interface KnowledgeRequest {
  sessionId: string;
  materials: Material[];
}

/** POST /api/knowledge 的响应即 KnowledgeResult */
export type KnowledgeResponse = KnowledgeResult;

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
  /** 更新后的依赖状态，正常为 MISSING → SUPPLEMENTED */
  status: PrerequisiteStatus;
  /** 递增后的材料版本 */
  materialVersion: number;
}

/* ============ GET /api/quiz ============ */

export interface QuizQuery {
  topic: Topic;
  source: QuizSource;
}

export interface QuizResponse {
  items: QuizItem[];
}

/* ============ GET /api/health ============ */

export interface HealthResponse {
  ok: boolean;
  version: string;
  modelProvider: string;
  /** 为 true 表示当前使用 mock 适配器，未接真实模型 */
  mock: boolean;
}
