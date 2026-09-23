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
import type { LowConfidenceSpan, Material, SessionSummary } from './session.js';
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

/* ============ GET /api/sessions ============ */

/**
 * 会话列表（2026-09-23 新增，**加性**）：只回**摘要**，不回材料正文与图谱。
 *
 * 顺序由服务端定：按 `updatedAt` **倒序**（最近变更的在前）。
 * ⚠️ 服务端是**内存实现**，进程重启后列表为空 —— 这是既定口径（§5.3），不是故障。
 */
export interface SessionListResponse {
  sessions: SessionSummary[];
}

/* ============ GET /api/health ============ */

/** 验证引擎状态（V2.0 §5.2 要求 health 如实报告通道与验证引擎） */
export interface VerificationEngineStatus {
  /** 引擎名，如 `mathjs` */
  engine: string;
  /** 是否可用；未接入时为 false，**不得伪报 true** */
  available: boolean;
}

/**
 * 运行形态自证（待办 `P-C12`）。
 *
 * 用途只有一个：**确认线上跑的是哪个产物**。部署之后，
 * 「本次响应来自构建产物还是源码直跑」不该靠人去猜。
 *
 * ⚠️ 该接口是公开的，因此**只报入口文件名，不回报本机绝对路径**
 * —— 回报绝对路径等于把开发机的目录结构公开出去。
 */
export interface BuildInfo {
  /** `dist` = 构建产物（部署形态）；`dev` = tsx 直跑源码 */
  mode: 'dist' | 'dev';
  /** 入口文件**文件名**（不含目录） */
  entry: string;
  /** 入口文件的修改时间（ISO 8601）；取不到时为 null，**不假装知道** */
  builtAt: string | null;
}

/**
 * 识别通道能力状态（`GET /api/health` 如实报告，V2.0 §5.2）。
 *
 * 与 `VerificationEngineStatus` 同一形状，但多一个 `note`：
 * 识别能力"未接入"不等于"坏了"，需要一句话说清边界，
 * 否则评委与队友只能靠猜（§9 诚实性红线）。
 */
export interface RecognitionCapabilityStatus {
  /** 通道标识，如 `model-vision` / `browser-speech` */
  engine: string;
  /** 是否可用；未接入时为 false，**不得伪报 true** */
  available: boolean;
  /** 能力边界的一句话说明（给人看） */
  note: string;
}

/** 两个识别入口的能力状态 */
export interface RecognitionCapabilities {
  image: RecognitionCapabilityStatus;
  audio: RecognitionCapabilityStatus;
}

export interface HealthResponse {
  ok: boolean;
  /**
   * 服务版本 —— 见待决策项 `I17` 的拍板：取 `@lc/server` 的 `package.json` 版本，
   * **运行时读取，取不到即 `null`**（与 `build.builtAt` 同一思路：不编一个
   * 看起来合理的值）。原先这里是硬编码 `'0.2.0'`，而五个 `package.json` 都是
   * `0.1.0` —— 全仓没有 `0.2.0` 的出处，评委对照源码仓库会先看到这个对不上的数字。
   *
   * ⚠️ **契约变更**：`string` → `string | null`。已核对消费方 —— `apps/web`
   * 不读该字段（界面不展示版本号），无调用点受影响。
   */
  version: string | null;
  modelProvider: string;
  /** 为 true 表示当前使用 mock 适配器，未接真实模型 */
  mock: boolean;
  verification: VerificationEngineStatus;
  /**
   * 识别通道（图片 / 语音）的真实可用性。
   *
   * **可选字段**（加性变更，与 `build?` 同一处理）：旧版服务端不返回它，
   * 读它的代码不得假定其存在。
   */
  capabilities?: RecognitionCapabilities;
  /**
   * 运行形态。**可选字段**（加性变更，消费方无需改动）：
   * 旧版服务端不返回它，读它的代码不得假定其存在。
   */
  build?: BuildInfo;
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
   * **能力级**字段：本次请求里，因为**通道尚未接入**而无法提供的识别通道。
   *
   * ⚠️ 它回答的是「**这条通道接没接**」（静态事实，与本次输入什么无关），
   * **不是**「本次有没有识别出东西」（动态结果）。两者混用会把"这次没有结果"
   * 读成"没有这个能力"——2026-09-22 修正过一次这类误报，判据见下。
   *
   * - `audio`：服务端**确实**不做语音转写（`D3` 走浏览器内置识别）⇒ 只要请求带了
   *   `audioBase64` 就如实列出。**这是本字段唯一正当的用法样例**；
   * - `image`：已接入，保留在联合类型里只为兼容更早的服务端快照，**新代码不产出**；
   * - ~~`formula`~~：**已移除**。公式由模型在**图片路径**上给出（`formulas`）；
   *   纯文字路径没有"识别公式"这一环。「本次没找到公式」用 `formulas` 为空表达即可，
   *   **不报警** —— 学生看到也无事可做，而"未接入"三个字会被读成功能没做。
   *
   * 说明书 §9 要求「不以模拟行为冒充真实能力」：未接入时如实报告，
   * 不得返回「【占位】已接收」这类会被误读为已解析的描述。
   */
  unavailable?: ('image' | 'audio')[];
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
