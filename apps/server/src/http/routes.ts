/**
 * 接口实现 —— 对应说明书 5.2「首日冻结的契约」
 *
 * 端点清单：POST /api/session（会话管理）、POST /api/parse、POST /api/knowledge、
 * POST /api/tutor、POST /api/gap、GET /api/quiz、GET /api/health
 *
 * ### 本文件的两条硬约定（2026-09-17 收口）
 *
 * 1. **错误响应只经 `respond()` 出口**。状态码与 `retryable` 一律查表推导
 *    （http/error-response.ts），不在分支里各自写死 —— 同一个契约错误码必须在
 *    所有路径上给出完全相同的答案。
 * 2. **入参先过形状校验再使用**（http/request-guards.ts）。此前把 `materials`
 *    传成字符串会抛 `TypeError` 落到 500，并把内部实现细节回给客户端；
 *    这类问题属客户端写错请求，应当是 400。
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
  HealthResponse,
  KnowledgeResponse,
  Material,
  ParseResponse,
  QuizResponse,
  Session,
  SupplementBlock,
  TutorResponse,
} from '@lc/contracts';
import { MATERIAL_LIMITS, MATERIAL_QUIZ_PER_TOPIC } from '@lc/contracts';
import { env } from '../config/env.js';
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
  commitSupplement,
  createSession,
  previewMaterials,
  requireSession,
} from '../store/index.js';

const adapter = createModelAdapter();

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
    version: '0.1.0',
    modelProvider: adapter.name,
    mock: adapter.isMock,
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

    const text = (rawText ?? '').trim();
    if (text.length === 0 && !rawImage) {
      throw new ApiError('BAD_REQUEST', '请至少提供文字或一张图片');
    }
    if (text.length > MATERIAL_LIMITS.maxSingleInputLength) {
      throw new ApiError(
        'BAD_REQUEST',
        `单次输入不能超过 ${MATERIAL_LIMITS.maxSingleInputLength} 字，当前 ${text.length} 字`,
      );
    }

    // TODO(B)：接入真实图文识别，输出识别文本与低置信度片段
    const response: ParseResponse = {
      // 识别文本默认可直接使用，不设确认阻断步骤（说明书 2.2）
      text,
      lowConfidence: [],
      ...(rawImage
        ? { imageDescription: '【占位】尚未接入真实视觉识别，图片仅记录为已接收。' }
        : {}),
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

    // 复核版本后一次性提交：模型调用期间若有并发请求提交过，这里会拒绝，
    // 避免用过期状态覆盖新状态（说明书 9.3、C3 验收）
    const updated = commitMaterials(session.id, incoming, baseVersion);

    const response: KnowledgeResponse = {
      sessionId: updated.id,
      materialVersion: updated.materialVersion,
      points: result.points,
      prerequisites: result.prerequisites,
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

    // 假引用与越权内容不得作为正常答案展示（说明书 4.3、用例 E7）。
    // 轻路径提问时学生主动提问即为授权，此时由 basedOnMaterial=false 承担标注责任。
    const { valid, rejected } = teaching.validateAnswerBlocks(result.blocks, allowedRefs, {
      requireAuthorization: sessionId !== null,
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
        materialVersion: session.materialVersion,
      };
      res.json(response);
      return;
    }

    const { content } = await teaching.supplementGap({
      conceptId,
      conceptName: conceptId,
      reason,
      materials: toSlices(session),
    });

    const supplement: SupplementBlock = {
      id: randomUUID(),
      sessionId: session.id,
      conceptId,
      content,
      authorizedAt: new Date().toISOString(),
    };
    // 复核版本后一次性提交：并发旧响应不得覆盖新状态（说明书 9.3）
    const updated = commitSupplement(session.id, supplement, baseVersion);

    const response: GapResponse = {
      content,
      supplementBlockId: supplement.id,
      status: 'SUPPLEMENTED',
      materialVersion: updated.materialVersion,
    };
    res.json(response);
  }),
);

/* ==================== GET /api/quiz ==================== */

apiRouter.get(
  '/quiz',
  asyncHandler(async (req, res) => {
    const teaching = teachingForRequest();
    // 课程范围严格限定为三个主题：非法取值直接报错，不返回空题集（说明书 2.6）
    const topic = unwrap(guardTopic(req.query.topic));
    const source = unwrap(guardQuizSource(req.query.source));

    if (source === 'fixed') {
      const response: QuizResponse = { items: FIXED_QUIZ[topic] ?? [] };
      res.json(response);
      return;
    }

    // 按材料出题需要会话上下文（说明书 2.6）
    const rawSessionId = req.query.sessionId;
    const sessionId =
      rawSessionId === undefined
        ? undefined
        : unwrap(guardNonEmptyText(rawSessionId, 'sessionId'));
    if (!sessionId) {
      throw new ApiError('BAD_REQUEST', '按材料出题需要提供 sessionId');
    }
    const session = requireSession(sessionId);

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
      })),
    };
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
