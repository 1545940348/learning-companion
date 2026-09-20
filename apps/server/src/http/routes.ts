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
 * 3. **未接入的能力如实报告，不用占位内容冒充**（§9）。例如 `/api/parse` 在视觉
 *    通道未接通时返回 `unavailable: ['image']`，而不是一句"图片已接收"的假描述。
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  FIXED_QUIZ,
  createTeachingModule,
  type AllowedRef,
  type MaterialSlice,
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
  Session,
  SupplementBlock,
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
import { describeBuild } from '../config/build-info.js';
import { logger } from '../logger.js';
import { createBudget, withBudget } from '../model/budget.js';
import { ModelError, redact } from '../model/errors.js';
import { createModelAdapter } from '../model/index.js';
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
import {
  SessionNotFoundError,
  SessionVersionConflictError,
  checkMaterialQuota,
  commitMaterials,
  commitProfileEvents,
  commitSupplement,
  createSession,
  getGraphNeighborhood,
  previewMaterials,
  requireSession,
} from '../store/index.js';

const adapter = createModelAdapter();

/**
 * 符号验证引擎状态（V2.0 §5.2 要求 `/api/health` 如实报告）。
 *
 * `available: true` —— 引擎已落地 **且已接进做题流程**：
 * - `packages/teaching/src/symbolic.ts` 已实现（`verify:symbolic` 37 项回归）；
 * - `/api/gap` 会用验证结果决定依赖状态（`VERIFIED` / `DISPUTED` / 停在 `SUPPLEMENTED`），
 *   见本文件下方 `gap.verification` 那段。
 *
 * ⚠️ 这个 `true` 的依据是"接进流程、会影响学生看到的结论"，**不是"模块写完了"** ——
 * 若哪天把接线回退掉，这里必须同步改回 `false`，否则 health 会虚报能力。
 */
const VERIFICATION_ENGINE: VerificationEngineStatus = { engine: 'mathjs', available: true };

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

/** 版本不匹配时拒绝，促使前端丢弃过期响应（说明书 5.3） */
function assertVersion(session: Session, materialVersion: number): void {
  if (materialVersion !== session.materialVersion) {
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

apiRouter.get('/health', (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    version: '0.2.0',
    modelProvider: adapter.name,
    mock: adapter.isMock,
    verification: VERIFICATION_ENGINE,
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
    if (rawImage && !text) {
      throw new ApiError(
        'BAD_REQUEST',
        `视觉识别尚未接入，无法仅凭图片识别内容。请补上文字描述（图片上限 ${MATERIAL_LIMITS.maxImageBytes / 1024 / 1024} MB）`,
      );
    }
    if (rawAudio && !text) {
      throw new ApiError(
        'BAD_REQUEST',
        `语音转写尚未接入，无法仅凭语音识别内容。请补上文字描述（单段语音上限 ${MAX_VOICE_SECONDS} 秒）`,
      );
    }

    // TODO(B5)：接入真实图文语音识别，输出识别文本、公式 LaTeX、图像结构化描述与低置信度片段。
    // 在接入前，图片与语音**如实报告为未接入**（§9：不以模拟行为冒充真实能力），
    // 不返回"【占位】图片已接收"这类会被误读为已解析的描述。
    const unavailable: NonNullable<ParseResponse['unavailable']> = [];
    if (rawImage) unavailable.push('image');
    if (rawAudio) unavailable.push('audio');
    unavailable.push('formula');

    const response: ParseResponse = {
      // 识别文本默认可直接使用，不设确认阻断步骤（说明书 2.2）
      text,
      lowConfidence: [],
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
    if (sessionId !== null) {
      const session = requireSession(sessionId);
      const requestedVersion =
        body.materialVersion === undefined
          ? session.materialVersion
          : unwrap(guardMaterialVersion(body.materialVersion));
      assertVersion(session, requestedVersion);
      materials = toSlices(session);
      allowedRefs = toAllowedRefs(session);
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

    const response: TutorResponse = {
      scope: result.scope,
      blocks: valid,
      basedOnMaterial: result.basedOnMaterial,
      ...(result.nextStep ? { nextStep: result.nextStep } : {}),
      /*
       * `I14`：**有块通过时，其余被拒的块不得无声消失**（§4.3「不静默」）。
       * 原先只在"全部被拒"时报错，一旦有块通过，被拒块就从响应里消失了 ——
       * 学生看到的是残缺答案，且无从知道少了一段。
       * 全部被拒时走上一条 `throw`（403），因此本字段只在"部分被丢弃"时出现。
       */
      ...(rejected.length > 0
        ? {
            droppedBlocks: {
              count: rejected.length,
              reasons: [...new Set(rejected.map((item) => item.reason))],
            },
          }
        : {}),
    };
    res.json(response);
  }),
);

/* ==================== POST /api/gap ==================== */

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
      const response: GapResponse = {
        content: existing.content,
        supplementBlockId: existing.id,
        status: 'SUPPLEMENTED',
        // 已有补充块若当时未通过验证，重放时也必须如实说「未验证」（§4.2）
        verification: existing.verification ?? DEFAULT_VERIFICATION,
        materialVersion: session.materialVersion,
      };
      res.json(response);
      return;
    }

    const gapResult = await teaching.supplementGap({
      conceptId,
      conceptName: conceptId,
      reason,
      materials: toSlices(session),
    });

    const { content, verification, claims, verdicts } = gapResult;

    /*
     * 依赖状态的推进规则（说明书 §3.2 六态、§4.4）：
     *   symbolic / human → VERIFIED（已符号验证或人工核验）
     *   failed           → DISPUTED（验证未通过，需人工介入）
     *   其余（无可验证断言、验证超时）→ 停在 SUPPLEMENTED
     *
     * ⚠️ `unverified` 时**不得**推进到 VERIFIED —— §4.2 规定补充内容必须经过
     * 符号验证或明确标记为未验证，不得默认视为正确。
     * 这条是本轮接线的核心：状态不再写死，而是由**验证结果**决定。
     */
    const nextStatus: PrerequisiteStatus = VERIFYING_STATUSES.includes(verification)
      ? 'VERIFIED'
      : verification === 'failed'
        ? 'DISPUTED'
        : 'SUPPLEMENTED';

    logger.info('gap.verification', {
      conceptId,
      verification,
      claimCount: claims.length,
      nextStatus,
      // 判定说明只进日志、供排查，不面向学生
      failedReasons: verdicts
        .filter((verdict) => verdict.status === 'failed')
        .map((verdict) => verdict.detail)
        .slice(0, 3),
    });

    const supplement: SupplementBlock = {
      id: randomUUID(),
      sessionId: session.id,
      conceptId,
      content,
      authorizedAt: new Date().toISOString(),
      verification,
    };
    // 复核版本后一次性提交：并发旧响应不得覆盖新状态
    const updated = commitSupplement(session.id, supplement, baseVersion, nextStatus);

    const response: GapResponse = {
      content,
      supplementBlockId: supplement.id,
      status: nextStatus,
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
     */
    if (session.materials.length === 0) {
      throw new ApiError(
        'BAD_REQUEST',
        '这个学习会话里还没有材料，无法「按我的材料出题」。请先提交讲义，或改用「项目自编题」（不依赖材料）。',
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

/* ==================== GET /api/teacher（P1，阶段三） ==================== */

/**
 * 教师视图。
 *
 * **本阶段刻意不实现**：说明书把教师视图列为 P1、计划在阶段三交付，
 * 且需要班级数据模型（当前不存在）。此处保留一个明确的 501 说明位，
 * 而不是返回空对象 —— 空对象会被前端与评审误读为"已实现但数据为空"（§9）。
 */
apiRouter.get('/teacher', (_req, res) => {
  respond(
    res,
    defaultStatusForApiCode('NOT_IMPLEMENTED'),
    'NOT_IMPLEMENTED',
    '教师视图（GET /api/teacher）计划在阶段三交付，当前版本尚未实现。',
  );
});

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
