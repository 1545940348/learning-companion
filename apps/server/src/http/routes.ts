/**
 * 接口实现 —— 对应说明书 V2.0 §5.3「共享契约」
 *
 * 端点清单（10 个）：POST /api/session、GET /api/health、POST /api/parse、
 * POST /api/knowledge、POST /api/tutor、POST /api/gap、POST /api/quiz、
 * POST /api/profile、GET /api/graph、GET /api/teacher（阶段三，未实现）。
 *
 * ### 本文件的三条硬约定
 *
 * 1. **错误响应只经 `respond()` 出口**。状态码与 `retryable` 一律查表推导
 *    （http/error-response.ts），不在分支里各自写死 —— 同一个契约错误码必须在
 *    所有路径上给出完全相同的答案。
 * 2. **入参先过形状校验再使用**（http/request-guards.ts）。此前把 `materials`
 *    传成字符串会抛 `TypeError` 落到 500，并把内部实现细节回给客户端；
 *    这类问题属客户端写错请求，应当是 400。
 * 3. **未接入的能力如实报告，不用占位内容冒充**（§9）。`/api/parse` 的 `unavailable`
 *    只列**通道未接入**的项（如服务端不转写的语音），不用占位内容冒充"已解析"；
 *    ⚠️ 它是**能力级**字段 —— **不得**拿它报告"本次没识别出东西"（见 `/parse` 内注释）。
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  FIXED_QUIZ,
  SYMBOLIC_ENGINE,
  createTeachingModule,
  verifySupplementContent,
  type AllowedRef,
  type MaterialSlice,
  type ModelCaller,
  type TeachingModule,
} from '@lc/teaching';
import type {
  ApiErrorBody,
  ApiErrorCode,
  GapResponse,
  GraphResponse,
  HealthResponse,
  KnowledgeResponse,
  Material,
  ParseResponse,
  PrerequisiteStatus,
  ProfileResponse,
  QuizResponse,
  LoginResponse,
  MeResponse,
  Session,
  SessionListResponse,
  SupplementBlock,
  TeacherResponse,
  TutorResponse,
  VerificationEngineStatus,
  VerificationStatus,
} from '@lc/contracts';
import {
  DEFAULT_VERIFICATION,
  MATERIAL_LIMITS,
  MATERIAL_QUIZ_PER_TOPIC,
  MAX_VOICE_SECONDS,
  VERIFYING_STATUSES,
} from '@lc/contracts';
import { env } from '../config/env.js';
import { describeBuild, describeVersion } from '../config/build-info.js';
import { logger } from '../logger.js';
import { createBudget, withBudget } from '../model/budget.js';
import { ModelError, redact } from '../model/errors.js';
import { createModelAdapter } from '../model/index.js';
import { RECOGNITION_CAPABILITIES } from '../parse/capabilities.js';
import { VisionInputError, normalizeImage, recognizeImage } from '../parse/vision.js';
import {
  classifyBodyError,
  defaultStatusForApiCode,
  isRetryableApiCode,
} from './error-response.js';
import { mapModelError } from './model-error-map.js';
import {
  guardMaterialVersion,
  guardMaterials,
  guardMode,
  guardNullableSessionId,
  guardNonEmptyText,
  guardOptionalText,
  guardProfileEvents,
  guardQuestion,
  guardQuizSource,
  guardRecentAnswers,
  guardSessionId,
  guardTopic,
  type Guard,
} from './request-guards.js';
import { buildDroppedBlocks } from './student-reason.js';
import { authenticate, issueToken, resolveToken, revokeToken } from '../auth/index.js';
import {
  SessionNotFoundError,
  SessionVersionConflictError,
  checkMaterialQuota,
  commitMaterials,
  commitProfileEvents,
  commitSupplement,
  createSession,
  aggregateClass,
  getGraphNeighborhood,
  listSessionSummaries,
  previewMaterials,
  requireSession,
} from '../store/index.js';

const adapter = createModelAdapter();

/**
 * 符号验证引擎状态（V2.0 §5.2 要求 `/api/health` 如实报告）。
 *
 * `B3` 已落地（2026-09-20）：引擎 = `mathjs`，实现在 `packages/teaching/src/symbolic.ts`。
 * 因此这里**由引擎自己的声明推导**，不再手写 `false` ——
 * 原先那句"**在实现落地前不得改为 true**"的红线已经满足（落地了就必须改），
 * 而"手写常量"这种写法本身就会漂移：引擎若被摘掉，health 还会说可用。
 */
const VERIFICATION_ENGINE: VerificationEngineStatus = {
  engine: SYMBOLIC_ENGINE.name,
  available: SYMBOLIC_ENGINE.available,
};

/**
 * 为**单次业务请求**创建教学模块实例，并挂上 60 秒总预算（说明书 V1.4）。
 *
 * 为什么每次请求新建：预算必须随请求走，而预算要作用在模型调用上；
 * 教学模块正是"调用模型"的那一层，所以由它的调用函数携带预算最直接
 * （`withBudget` 包装 `ModelCaller`，教学模块代码零改动）。
 * `createTeachingModule` 只返回一组闭包，创建开销可忽略。
 */
function teachingForRequest(): TeachingModule {
  return createTeachingModule(withBudget(adapter.call, createBudget(env.modelTimeoutMs)));
}

/**
 * 视觉识别用的模型调用函数（同样挂单请求总预算）。
 *
 * 与 `teachingForRequest()` 同源 —— 预算必须**随请求走**，因此不缓存、每次新建。
 * 识别**不经教学模块**：它不是"教学"而是"把图变成字"，属于 `parse/` 的职责。
 */
function budgetedCaller(): ModelCaller {
  return withBudget(adapter.call, createBudget(env.modelTimeoutMs));
}

/** 用于文案的预算秒数：与 `MODEL_TIMEOUT_MS` 保持一致，不再写死 60（避免改了配置文案还在说 60 秒） */
function budgetSeconds(): number {
  return Math.max(1, Math.round(env.modelTimeoutMs / 1000));
}

export class ApiError extends Error {
  /** 状态码由**错误码**推导（http/error-response.ts 的唯一表），不逐处传参，避免分叉 */
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? defaultStatusForApiCode(code);
  }
}

/** 校验守卫的统一出入口：不通过即 400，且文案由守卫给出（说清哪个字段不对） */
function unwrap<T>(guard: Guard<T>): T {
  if (!guard.ok) {
    throw new ApiError('BAD_REQUEST', guard.problem);
  }
  return guard.value;
}

/**
 * 取出 JSON 请求体。
 *
 * `express.json()` 在 body 是 JSON 标量（如 `"abc"`、`123`）时会把它原样解析出来，
 * 那种情况下按"没有可用字段"处理，让各接口的守卫给出明确的 400，
 * 而不是在这一层抛异常。
 */
function readBody(req: Request): Record<string, unknown> {
  const raw: unknown = req.body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** 会话内全部可引用来源，顺序为：学生材料在前、系统补充在后 */
function toSlices(session: Session): MaterialSlice[] {
  return [
    ...session.materials.map((material) => ({
      id: material.id,
      kind: material.kind,
      text: material.text,
    })),
    ...session.supplements.map((supplement) => ({
      id: supplement.id,
      kind: 'ai-supplement' as const,
      text: supplement.content,
    })),
  ];
}

/** 构造校验允许的引用集合。补充块带 authorized 标记，用于拦截越权内容 */
function toAllowedRefs(session: Session): AllowedRef[] {
  return [
    ...session.materials.map((material) => ({
      refId: material.id,
      sourceType: 'material' as const,
      text: material.text,
      authorized: true,
    })),
    ...session.supplements.map((supplement) => ({
      refId: supplement.id,
      sourceType: 'ai-supplement' as const,
      text: supplement.content,
      // 补充块是学生点击后生成的，视为已授权（说明书 4.2）
      authorized: true,
    })),
  ];
}

/* 学生话术改写（`I35`）已提到**无副作用**的叶子模块 `./student-reason.js`（`W0-7①`）——
 * 原先是本文件里的私有函数，而本文件在模块顶层就 `Router()` 建路由表，
 * 验证脚本 import 它会连 express 一起拉起，断言跑不起来。 */

/** 版本不匹配时拒绝，促使前端丢弃过期响应（说明书 5.3） */
function assertVersion(session: Session, materialVersion: number): void {  if (materialVersion !== session.materialVersion) {
    throw new ApiError(
      'SESSION_STALE',
      `材料版本已更新（当前 ${session.materialVersion}，请求针对 ${materialVersion}），请基于最新状态重试`,
    );
  }
}

export const apiRouter: Router = Router();

/* ==================== 会话管理 ==================== */

apiRouter.post('/session', (_req, res) => {
  const session = createSession();
  res.status(201).json(session);
});

/**
 * 列出会话摘要（`P2-1`，2026-09-23 新增）。
 *
 * ### 为什么只回摘要
 *
 * 见 `SessionSummary` 的注释：列表页不该顺带把**讲义原文**吐出来。
 * 这里刻意**不做分页** —— 服务端是内存实现、单进程演示环境，会话量以个位计；
 * 加一个用不上的分页参数只会制造"看起来完备"的错觉。
 *
 * ⚠️ **无入参、无需守卫**：接口不带 `sessionId`，因此不经过 `request-guards`。
 * ⚠️ 进程重启后列表为空 —— 既定口径（§5.3），**不是故障**，界面侧应如实说明。
 */
apiRouter.get('/sessions', (_req, res) => {
  const response: SessionListResponse = { sessions: listSessionSummaries() };
  res.json(response);
});

apiRouter.get('/health', (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    // I17 拍板：运行时读 @lc/server 的 package.json；取不到即 null，不硬编码
    version: describeVersion(),
    modelProvider: adapter.name,
    mock: adapter.isMock,
    verification: VERIFICATION_ENGINE,
    // 识别通道（图片/语音）如实报告：语音不由服务端转写，见 parse/capabilities.ts
    capabilities: RECOGNITION_CAPABILITIES,
    // 运行形态自证（P-C12）：让"线上跑的是哪个产物"可核对，不靠人猜
    build: describeBuild(),
  };
  res.json(body);
});

/* ==================== POST /api/parse ==================== */

apiRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const body = readBody(req);

    const rawText = body.text;
    if (rawText !== undefined && typeof rawText !== 'string') {
      throw new ApiError('BAD_REQUEST', 'text 必须是字符串');
    }
    const rawImage = body.imageBase64;
    if (rawImage !== undefined && typeof rawImage !== 'string') {
      throw new ApiError('BAD_REQUEST', 'imageBase64 必须是字符串');
    }
    const rawAudio = body.audioBase64;
    if (rawAudio !== undefined && typeof rawAudio !== 'string') {
      throw new ApiError('BAD_REQUEST', 'audioBase64 必须是字符串');
    }

    const text = (rawText ?? '').trim();
    if (text.length === 0 && !rawImage && !rawAudio) {
      throw new ApiError('BAD_REQUEST', '请至少提供文字、一张图片或一段语音');
    }
    if (text.length > MATERIAL_LIMITS.maxSingleInputLength) {
      throw new ApiError(
        'BAD_REQUEST',
        `单次输入不能超过 ${MATERIAL_LIMITS.maxSingleInputLength} 字，当前 ${text.length} 字`,
      );
    }
    if (rawAudio && !text && !rawImage) {
      throw new ApiError(
        'BAD_REQUEST',
        `语音不由服务端转写（识别在浏览器侧完成，见 /api/health 的 capabilities.audio）。` +
          `请用界面上的「语音输入」边说边转文字，或直接粘贴文字（单段语音上限 ${MAX_VOICE_SECONDS} 秒）`,
      );
    }

    /*
     * ==================== 视觉路径（2026-09-21 接入） ====================
     *
     * 图片**由服务端识别**（不像语音）：交给 `parse/vision.ts`，用已接入的模型通道
     * 把图转成文本。识别结果是「文本」，所以下游（材料 → 图谱 → 缺口）
     * **完全复用现有管道**，这一层只做接线。
     *
     * 两类失败分开处置，不混为一谈：
     * - **入参不合法**（超限/格式不对/不是 base64）→ `VisionInputError` → 400，
     *   并把**具体原因**透给学生（"图片 6.2 MB 超过上限 5 MB"比"请求无效"有用）；
     * - **模型侧失败**（超时/鉴权/配额）→ **原样抛出**，交给 `asyncHandler` 与
     *   `mapModelError` 走既有映射，**不在这里另立一套状态码**。
     */
    let recognized: Awaited<ReturnType<typeof recognizeImage>> | null = null;
    if (rawImage) {
      try {
        recognized = await recognizeImage(normalizeImage(rawImage), {
          // 学生同时写的文字：既当识别提示，也保留进正文（不静默丢内容）
          ...(text.length > 0 ? { hint: text } : {}),
          caller: budgetedCaller(),
        });
      } catch (error) {
        if (error instanceof VisionInputError) {
          throw new ApiError('BAD_REQUEST', error.message);
        }
        throw error;
      }
    }

    /*
     * `unavailable` 的语义是**「这条通道接没接」**（能力级 · 静态，与本次输入什么无关），
     * 不是「本次有没有识别出东西」—— 逐条落点见 `packages/contracts/src/api.ts` 的字段说明。
     *
     * - `image`：已接入（上面那段）⇒ **永不列出**；
     * - `audio`：服务端**确实**不做 ASR（`D3` 拍板走浏览器内置识别），是硬事实
     *   ⇒ 只要本次真的带了语音，就如实列出；
     * - `formula`：**永不列出**。图片路径已接入（`formulas` 由模型给出）；
     *   纯文字路径**压根没有"识别公式"这一环**，也就无所谓"未接入"。
     *
     * ⚠️ **2026-09-22 修正（用户指正）**：原先这里是
     * `if ((recognized?.formulas?.length ?? 0) === 0) unavailable.push('formula')`
     * —— 拿**本次有没有拿到公式**反推**通道有没有接**，把"结果"塞进了"能力"字段。后果：
     * 纯文字输入**必然**被判成"公式识别（LaTeX）未接入"；图片里本来就**没有**公式
     * （纯叙述段落）也会被判成未接入 —— 两处都不是真话。
     * 「本次没找到公式」用 `formulas` 为空表达即可，**不报警**（学生知道也没事可做，
     * 那句话只会被读成"功能没做"）。
     */
    const unavailable: NonNullable<ParseResponse['unavailable']> = [];
    if (rawAudio) unavailable.push('audio');

    const response: ParseResponse = {
      // 仅文字：识别文本默认可直接使用，不设确认阻断步骤（说明书 2.2）
      ...(recognized ?? { text, lowConfidence: [] }),
      ...(unavailable.length > 0 ? { unavailable } : {}),
    };
    res.json(response);
  }),
);

/* ==================== POST /api/knowledge ==================== */

apiRouter.post(
  '/knowledge',
  asyncHandler(async (req, res) => {
    const teaching = teachingForRequest();
    const body = readBody(req);
    const session = requireSession(unwrap(guardSessionId(body.sessionId)));
    const incoming: Material[] = unwrap(guardMaterials(body.materials));

    const quotaError = checkMaterialQuota(session, incoming);
    if (quotaError) {
      throw new ApiError('BAD_REQUEST', quotaError);
    }

    // 记下本次分析所基于的版本，提交前要复核（说明书 9.3）
    const baseVersion = session.materialVersion;

    // 只构造候选，**不写入存储**：模型失败时材料与版本都不变（说明书 2.4、9.3）
    const candidate = previewMaterials(session, incoming);
    const result = await teaching.analyzeKnowledge({ materials: toSlices(candidate) });

    // 复核版本后一次性提交：**材料与图谱在同一次 CAS 中写入**（§3.3 步骤 5）。
    // 模型调用期间若有并发请求提交过，这里会拒绝，避免用过期状态覆盖新状态。
    const updated = commitMaterials(session.id, incoming, baseVersion, result.graph);

    const response: KnowledgeResponse = {
      sessionId: updated.id,
      materialVersion: updated.materialVersion,
      points: result.points,
      prerequisites: result.prerequisites,
      // 返回**实际落盘**的图谱，而不是模型刚给的候选：
      // 二者在"图谱为空时不清空旧图谱"的情形下会不同，前端应按落盘结果渲染。
      graph: updated.graph,
    };
    res.json(response);
  }),
);

/* ==================== POST /api/tutor ==================== */

apiRouter.post(
  '/tutor',
  asyncHandler(async (req, res) => {
    const teaching = teachingForRequest();
    const body = readBody(req);

    const question = unwrap(guardQuestion(body.question));
    const mode = unwrap(guardMode(body.mode));
    const knowledgePointId = unwrap(guardOptionalText(body.knowledgePointId, 'knowledgePointId'));
    const recentAnswers = unwrap(guardRecentAnswers(body.recentAnswers));

    // null 表示轻路径（零材料）提问（说明书 2.1）；字段被省略属调用方写错，由守卫明确报 400
    const sessionId = unwrap(guardNullableSessionId(body.sessionId));

    let materials: MaterialSlice[] = [];
    let allowedRefs: AllowedRef[] = [];
    /*
     * `I36`（本轮新登记）：**只统计学生自己的材料**，不含 AI 补充块。
     *
     * 契约对 `basedOnMaterial` 的定义是「是否基于**学生材料**作答；轻路径为 false」。
     * 而教学层拿到的是 `toSlices(session)` = 学生材料 **+ 已授权补充块**，它按
     * `input.materials.length > 0` 计算 → 「只有 AI 补充内容、没有讲义」的会话
     * 会被报成"基于你的材料作答"，界面据此显示「基于你的材料生成」——
     * 与学生实际提交的东西不符。这是真实性问题（同 `I20⑦`、`I30` 一类），
     * 不是体验问题：有来源 ≠ 有学生材料。
     */
    let hasStudentMaterial = false;
    if (sessionId !== null) {
      const session = requireSession(sessionId);
      const requestedVersion =
        body.materialVersion === undefined
          ? session.materialVersion
          : unwrap(guardMaterialVersion(body.materialVersion));
      assertVersion(session, requestedVersion);
      materials = toSlices(session);
      allowedRefs = toAllowedRefs(session);
      hasStudentMaterial = session.materials.length > 0;
    }

    const result = await teaching.answerQuestion({
      question,
      mode,
      materials,
      ...(knowledgePointId ? { knowledgePointId } : {}),
      ...(recentAnswers ? { recentAnswers } : {}),
    });

    /*
     * 假引用与越权内容不得作为正常答案展示（说明书 4.3、用例 E7）。
     *
     * ⚠️ 判据是「本次请求是否真的带了可引用的来源」，**不是「会话是否存在」**（`I13`）。
     * 原先写 `sessionId !== null`：学生点「开始新学习」或「按我的材料出题」之后
     * 会话已存在但材料为空，此时提问会因"AI 补充内容无授权来源"被 403 且 `retryable=false`
     * —— 而同一个问题走 `sessionId: null` 却正常。**有会话不等于有材料。**
     * 零材料时由 `basedOnMaterial === false` 承担标注责任（说明书 2.1）。
     *
     * 注：此处 `materials` 已是「学生材料 + 已授权补充块」的切片列表，
     * 因此它与 `allowedRefs` 同为空／非空 —— 只要存在一个可引用的来源就要求绑定。
     */
    const requireAuthorization = materials.length > 0;
    const { valid, rejected } = teaching.validateAnswerBlocks(result.blocks, allowedRefs, {
      requireAuthorization,
    });
    if (valid.length === 0 && rejected.length > 0) {
      throw new ApiError(
        'UNAUTHORIZED_CONTENT',
        `回答未通过来源校验：${rejected.map((item) => item.reason).join('；')}`,
      );
    }

    // 被拒块的**对外**表述（`I14`/`I35`）：构造逻辑在 `student-reason.ts`，
    // 无丢弃时为 `null` —— 此处只负责"有则挂上"
    const droppedBlocks = buildDroppedBlocks(rejected);

    if (rejected.length > 0) {
      // I35：原始原因（含 refId）只留在服务端日志里，学生界面拿到的是改写后的话术
      logger.warn('tutor.blocks.dropped', {
        count: rejected.length,
        reasons: rejected.map((item) => item.reason),
      });
    }

    const response: TutorResponse = {
      scope: result.scope,
      blocks: valid,
      // I36：按契约语义取「有没有学生材料」，不用教学层的切片长度（后者含补充块）
      basedOnMaterial: hasStudentMaterial,
      ...(result.nextStep ? { nextStep: result.nextStep } : {}),
      // `I14`：有块通过时，其余被拒的块不得无声消失（§4.3「不静默」）——
      // 构造逻辑见 `student-reason.ts` 的 `buildDroppedBlocks()`，无丢弃时为 `null`
      ...(droppedBlocks ? { droppedBlocks } : {}),
    };
    res.json(response);
  }),
);

/* ==================== POST /api/gap ==================== */

/**
 * 由验证状态推导六态里的状态 —— §3.4 的硬规则。
 *
 * `VERIFYING_STATUSES`（`symbolic` / `human`）是"通过"的**唯一依据**。
 * 这个常量在契约里定义了却一直零引用（`I18`："规则声明了却没接线"），这里把它接上：
 * 以后判定口径只有一个来源，不会再出现"某处自己写死一个字符串"的分叉。
 */
function deriveSupplementStatus(verification: VerificationStatus): PrerequisiteStatus {
  if (verification === 'failed') return 'DISPUTED';
  return VERIFYING_STATUSES.includes(verification) ? 'VERIFIED' : 'SUPPLEMENTED';
}

/**
 * 从图谱**入边**读该概念的实际状态（用于 `/api/gap` 的幂等重放，`I16`）。
 *
 * 原先重放分支硬编码 `status: 'SUPPLEMENTED'` —— 概念早已 `VERIFIED` 时却回"已补充"，
 * 是**低报**，也是错的。
 *
 * 返回 `null` 表示**读不到**：要么该概念没有入边，要么多条入边状态互相矛盾
 * —— 这时由调用方改用"按已有补充块的验证状态推导"，**不猜**。
 */
function readConceptStatus(session: Session, conceptId: string): PrerequisiteStatus | null {
  const statuses = [
    ...new Set(
      session.graph.edges.filter((edge) => edge.to === conceptId).map((edge) => edge.status),
    ),
  ];
  return statuses.length === 1 ? (statuses[0] as PrerequisiteStatus) : null;
}

/**
 * 从图谱节点反查概念的**中文名**（`I15`）。
 *
 * 原先 `/api/gap` 传的是 `conceptName: conceptId`，于是真实模型看到的是
 * `kp-derivative（kp-derivative）` —— 把内部编号当名字用。
 *
 * ⚠️ **现管线里这个反查通常查不到**：图谱节点只由 `points[]`（材料抽出的知识点）构成，
 * 而这里要补的是 `prerequisites[]` 里的前置概念 —— 两者不是同一批 id（详见 `I34`/`I42`）。
 * 因此**如实退回 `conceptId`**：宁可让模型看到编号，也不编一个名字出来。
 */
function findConceptName(session: Session, conceptId: string): string | null {
  const node = session.graph.nodes.find((item) => item.id === conceptId);
  if (!node) return null;
  const name = node.name.trim();
  // `name` 缺省时会被归一成 id 本身，那不算"查到了名字"
  return name.length > 0 && name !== node.id ? name : null;
}

apiRouter.post(
  '/gap',
  asyncHandler(async (req, res) => {
    const teaching = teachingForRequest();
    const body = readBody(req);
    const sessionId = unwrap(guardSessionId(body.sessionId));
    const materialVersion = unwrap(guardMaterialVersion(body.materialVersion));
    const conceptId = unwrap(guardNonEmptyText(body.conceptId, 'conceptId'));
    const reason = unwrap(guardNonEmptyText(body.reason, 'reason'));

    const session = requireSession(sessionId);
    assertVersion(session, materialVersion);

    // 记下本次生成所基于的版本；模型调用期间（约 1—3 秒）可能有并发请求提交过，
    // 提交前须复核（说明书 9.3）
    const baseVersion = session.materialVersion;

    const existing = session.supplements.find(
      (supplement) => supplement.conceptId === conceptId,
    );
    if (existing) {
      // 幂等：同一缺口重复补充时直接返回已有内容，避免无谓消耗
      const existingVerification = existing.verification ?? DEFAULT_VERIFICATION;
      const response: GapResponse = {
        content: existing.content,
        supplementBlockId: existing.id,
        /*
         * `I16`：状态从**图谱实况**读，不再硬编码 `'SUPPLEMENTED'`。
         * 读不到（无边／矛盾）才退回"按已有补充块的验证状态推导"。
         */
        status:
          readConceptStatus(session, conceptId) ?? deriveSupplementStatus(existingVerification),
        // 已有补充块若当时未通过验证，重放时也必须如实说「未验证」（§4.2）
        verification: existingVerification,
        materialVersion: session.materialVersion,
      };
      res.json(response);
      return;
    }

    /*
     * `I15`：把**概念名**送进提示词。反查不到就退回 `conceptId`（见 `findConceptName` 的说明），
     * 不再把编号当名字用。
     */
    const conceptName = findConceptName(session, conceptId) ?? conceptId;

    const { content, claims } = await teaching.supplementGap({
      conceptId,
      conceptName,
      reason,
      materials: toSlices(session),
    });

    /*
     * `B3`：验证状态由**符号引擎**给出（`packages/teaching/src/symbolic.ts`），不再固定 `unverified`。
     *
     * 判据：模型的 `claims` 逐条核验 —— 全过 → `symbolic`；任一不过 → `failed`；
     * 没有断言 / 表达式转不了 / 超出规模上限 → `unverified`（**"没有断言"不等于"通过"**）。
     * 另外补上长度核对：`SUPPLEMENT_LENGTH`（200—400 字）超区间的内容照常返回，
     * 但**不据此标"已符号验证"**。
     */
    const verificationReport = verifySupplementContent({ content, claims });
    const verification: VerificationStatus = verificationReport.status;
    const status = deriveSupplementStatus(verification);

    const supplement: SupplementBlock = {
      id: randomUUID(),
      sessionId: session.id,
      conceptId,
      content,
      authorizedAt: new Date().toISOString(),
      verification,
    };
    // 复核版本后一次性提交：并发旧响应不得覆盖新状态
    const updated = commitSupplement(session.id, supplement, baseVersion, status);

    const response: GapResponse = {
      content,
      supplementBlockId: supplement.id,
      status,
      verification,
      materialVersion: updated.materialVersion,
    };
    res.json(response);
  }),
);

/* ==================== POST /api/quiz ==================== */

/**
 * ⚠️ V2.0 起由 `GET /api/quiz?topic=&source=` 改为 `POST`（§5.3）。
 * 入参不再是 query 而是 body，A 侧调用须同批改造。
 */
apiRouter.post(
  '/quiz',
  asyncHandler(async (req, res) => {
    const teaching = teachingForRequest();
    const body = readBody(req);

    // 课程范围严格限定为三个主题：非法取值直接报错，不返回空题集（说明书 2.6）
    const topic = unwrap(guardTopic(body.topic));
    const source = unwrap(guardQuizSource(body.source));

    if (source === 'fixed') {
      const response: QuizResponse = {
        // 自编固定题经人工核验，验证状态标 human（§7.1 固定题须人工核验 + 符号验证）
        items: (FIXED_QUIZ[topic] ?? []).map((item) => ({ ...item, verification: 'human' })),
      };
      res.json(response);
      return;
    }

    // 按材料出题需要会话上下文（说明书 2.6）
    const sessionId = unwrap(guardNonEmptyText(body.sessionId, 'sessionId'));
    const session = requireSession(sessionId);

    /*
     * `I20⑥`：会话里**没有材料**时必须拒绝，不能返回标着 `source: 'material'` 的题。
     *
     * 原先直接拿空材料去出题，模型侧只是收到「（学生未提供任何材料）」，
     * 返回的题却被本接口统一标成 `source: 'material'`，前端据此显示
     * 「基于你的材料生成」—— 而题目与学生的材料毫无关系。**这是真实性红线，不是体验问题。**
     * 拒绝并说清该怎么做，比给一组"看起来像基于材料"的题更诚实（§9）。
     *
     * ### `I30` 拍板：口径说明（不改契约）
     *
     * 同一会话上 `/api/tutor` 会把补充块经 `toSlices()` 当作**可引用来源**，
     * 而这里只认 `session.materials` —— 两者看似矛盾，实则回答的是**两个不同问题**：
     * - `/api/tutor` 问「有没有可引用的来源」（学生材料 **或** 已授权补充块）；
     * - `/api/quiz` 问「有没有**学生自己的材料**」，因为返回的题必须标
     *   `source: 'material'`，而契约的 `QuizSource` 只有 `'fixed' | 'material'`
     *   两个取值 —— 拿补充块出的题标成 `'material'` 就是**新的真实性红线**。
     *
     * 所以不清一色地放宽判据，而是把**文案**说到与判据一致：会话里只有补充块时，
     * 明说是"只有 AI 补充内容、没有你的讲义"，而不是笼统一句"还没有材料"
     * （后者会让学生以为会话是空的，去翻一个其实有内容的会话）。
     */
    if (session.materials.length === 0) {
      const supplementCount = session.supplements.length;
      throw new ApiError(
        'BAD_REQUEST',
        supplementCount > 0
          ? `这个会话里只有 ${supplementCount} 段 AI 补充内容，没有你自己的讲义，因此无法「按我的材料出题」（那会把这些题标成「基于你的材料生成」，与你实际提供的材料不符）。请先提交讲义，或改用「项目自编题」。`
          : '这个学习会话里还没有材料，无法「按我的材料出题」。请先提交讲义，或改用「项目自编题」（不依赖材料）。',
      );
    }

    const items = await teaching.generateQuizFromMaterial({
      topic,
      count: MATERIAL_QUIZ_PER_TOPIC,
      materials: toSlices(session),
    });

    const response: QuizResponse = {
      items: items.map((item, index) => ({
        ...item,
        id: item.id ?? `gen-${topic}-${index}`,
        topic,
        // 必须标注来源，不能伪装成上传讲义原题（说明书 2.6）
        source: 'material',
        // 生成题缺省「未验证」（§4.2）
        verification: item.verification ?? DEFAULT_VERIFICATION,
      })),
    };
    res.json(response);
  }),
);

/* ==================== GET /api/graph ==================== */

/**
 * 图谱邻域（§2.3 图谱视图）。
 *
 * 数据来自会话里**已落盘**的图谱 —— 这正是 C1 要解决的问题：
 * 在此之前 `/api/knowledge` 算完即丢，本接口无数据可读。
 * 只做一层邻域展开，不做多跳递归（§3.6 不扩展到全课程网络）。
 */
apiRouter.get(
  '/graph',
  asyncHandler(async (req, res) => {
    const sessionId = unwrap(guardNonEmptyText(req.query.sessionId, 'sessionId'));
    const knowledgePointId = unwrap(
      guardOptionalText(req.query.knowledgePointId, 'knowledgePointId'),
    );

    const session = requireSession(sessionId);
    const neighborhood = getGraphNeighborhood(session, knowledgePointId ?? null);

    const response: GraphResponse = neighborhood;
    res.json(response);
  }),
);

/* ==================== POST /api/profile ==================== */

/**
 * 提交画像事件，取回更新后的画像（§5.3）。
 *
 * 只做会话内聚合（阶段二「画像基础版」）。注意两点：
 * - `gap-claimed-known`（学生选"我已掌握"）**不改变材料覆盖状态**（§2.3）；
 * - 画像事件可跨会话保留，但 AI 补充内容不迁移（用例 E16）。
 */
apiRouter.post(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = readBody(req);
    const sessionId = unwrap(guardSessionId(body.sessionId));
    const events = unwrap(guardProfileEvents(body.events, sessionId));

    const session = requireSession(sessionId);
    const profile = commitProfileEvents(session, events);

    const response: ProfileResponse = profile;
    res.json(response);
  }),
);

/* ==================== 账号（演示级，`D7` 口径；2026-09-23） ==================== */

/**
 * 令牌从 **`X-LC-Token` 请求头**取，**不用 Cookie**。
 *
 * 这样浏览器就不会自动附带它 ⇒ **不存在 CSRF 面**。
 * 计划书要求"归属校验 ＋ CSRF 必须同批上线"，这里靠"取消 Cookie"让后半句自动成立 ——
 * 比加一个防不住的 CSRF token 更实在。
 *
 * 参数用结构化类型（只要求有 `header`），省掉对 `express` 类型的耦合。
 */
function tokenOf(req: { header: (name: string) => string | undefined }): string | undefined {
  const value = req.header('x-lc-token');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

apiRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = await readBody(req);
    const username = unwrap(guardNonEmptyText(body.username, 'username'));
    const password = unwrap(guardNonEmptyText(body.password, 'password'));

    const account = authenticate(username, password);
    if (!account) {
      /*
       * ⚠️ 失败原因**不区分**"用户不存在"与"口令不正确" ——
       * 区分开就等于提供了一个**账号枚举接口**。
       */
      throw new ApiError('UNAUTHORIZED', '用户名或口令不正确。');
    }
    const response: LoginResponse = { token: issueToken(account), account };
    res.json(response);
  }),
);

apiRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    revokeToken(tokenOf(req));
    res.json({ ok: true });
  }),
);

apiRouter.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    /*
     * ⚠️ **未登录时返回 200 ＋ `account: null`，不是 401** ——
     * "还没登录"是**正常状态**（首屏就该能提问），不是错误。
     * 返 401 会让前端把例行查询当失败、弹出无意义的重试。
     */
    const response: MeResponse = { account: resolveToken(tokenOf(req)) };
    res.json(response);
  }),
);

/* ==================== GET /api/teacher（P1，阶段三） ==================== */

/**
 * 教师视图：班级聚合（`P-C11`，**2026-09-23 由 501 改为已实现**）。
 *
 * ### 与"刻意不实现"那段口径的关系
 *
 * 本条原先返回 501，理由写在旧注释里：「需要班级数据模型（当前不存在），
 * 保留一个明确的 501 说明位，而不是返回空对象」—— 那个判断**本身没错**：
 * 空对象会被误读成"已实现但没数据"。
 * 现在改为实现，靠的是**不假装有班级**：把当前进程内的会话视为一个班、
 * `classId` 原样回显，并在响应体里如实报出 `studentCount`；
 * 样本不足（< `TEACHER_MIN_SAMPLE`）由**界面**提示「样本不足」，不由服务端编数据。
 *
 * ### 只读与脱敏（用例 E17）
 *
 * 返回体**只含计数与概念维度统计**：状态分布、误区排行、覆盖热度。
 * 没有任何字段能反推到某个具体学生 —— 这也是契约对 `ClassAggregate` 的定义。
 */
apiRouter.get(
  '/teacher',
  asyncHandler(async (req, res) => {
    const classId = unwrap(guardNonEmptyText(req.query.classId, 'classId'));
    const response: TeacherResponse = aggregateClass(classId);
    res.json(response);
  }),
);

/**
 * 未匹配的 /api 路径。
 *
 * 不加这一条时 Express 会回默认 HTML 404 页，前端 `request()` 解析 JSON 失败，
 * 只能退化成"请求失败（HTTP 404）"，与"统一错误结构"的约定不符（说明书 5.2）。
 */
apiRouter.use((req, _res, next) => {
  next(new ApiError('NOT_FOUND', `接口不存在：${req.method} ${req.originalUrl}`));
});

/* ==================== 统一错误处理 ==================== */

/**
 * 唯一的错误响应出口。
 *
 * `retryable` **默认由错误码推导**，不允许调用方随手写 true/false ——
 * 这正是原先同一个 `SESSION_STALE` 在两条路径上给出不同答案的根因。
 *
 * `retryableOverride` 只为一处保留：`ModelError` 的 5 分类比 `ApiErrorCode` 更细
 * （`UPSTREAM` 可重试而认证失败不可重试，两者都映射到 `MODEL_ERROR`），
 * 此时以更细的码为准，由 `model-error-map.ts` 提供。
 */
function respond(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  retryableOverride?: boolean,
): void {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      retryable: retryableOverride ?? isRetryableApiCode(code),
    },
  };
  res.status(status).json(body);
}

export function errorHandler(
  error: unknown,
  _req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  _next: Parameters<RequestHandler>[2],
): void {
  if (res.headersSent) {
    return;
  }

  // 请求体解析失败：属**客户端**把 body 写坏了，不能落到兜底变 500
  // （原实现会返回 500 INTERNAL 并把解析器原文回给客户端）
  const bodyError = classifyBodyError(error);
  if (bodyError) {
    respond(res, bodyError.status, bodyError.code, bodyError.message);
    return;
  }

  if (error instanceof ApiError) {
    respond(res, error.status, error.code, error.message);
    return;
  }

  if (error instanceof SessionNotFoundError) {
    respond(res, 404, 'NOT_FOUND', error.message);
    return;
  }

  // 提交前复核版本发现冲突：本次结果基于过期状态，已丢弃（说明书 9.3）
  // 与 /tutor、/gap 入口处的 assertVersion 走**同一个错误码、同一个状态码、同一个 retryable**
  if (error instanceof SessionVersionConflictError) {
    respond(
      res,
      defaultStatusForApiCode('SESSION_STALE'),
      'SESSION_STALE',
      error.message,
    );
    return;
  }

  // 模型错误统一映射（说明书 V1.4 第 9.3 节）：
  // 401 认证 / 429 额度 / 504 超时 / 502 上游 / 400 请求不合法。
  // 必须放在最后的兜底分支之前，否则模型故障会被一律吞成 500。
  //
  // 这里用 `mapModelError` 的 `retryable` 而不再由 `ApiErrorCode` 推导：
  // `ModelErrorCode` 有 5 个取值，比 `ApiErrorCode` 的 `MODEL_ERROR` 更细
  // （例如 UPSTREAM 故障可重试，而认证失败不可重试）—— 更细的码说了算。
  if (error instanceof ModelError) {
    const mapped = mapModelError(error.code);
    respond(res, mapped.status, mapped.code, error.message, mapped.retryable);
    return;
  }

  // 兜底：AbortError 说明确实是超时；其余为未分类的服务器内部错误
  if (error instanceof Error && error.name === 'AbortError') {
    respond(
      res,
      504,
      'MODEL_TIMEOUT',
      `模型响应超过 ${budgetSeconds()} 秒，请重试（已保留你的输入）`,
    );
    return;
  }

  // INTERNAL 意味着我们有缺陷：**不回显内部报错原文**（避免泄露实现细节），
  // 也**不标可重试** —— 让前端给学生"再试一次"是误导。真实原因写进服务端日志。
  logger.error('http.unhandled', { message: redact(error, []).slice(0, 300) });
  respond(res, 500, 'INTERNAL', '服务器内部错误，本次请求未能完成。');
}
