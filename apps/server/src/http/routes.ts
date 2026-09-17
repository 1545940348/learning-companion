/**
 * 接口实现 —— 对应说明书 5.2「首日冻结的契约」
 *
 * 端点清单：POST /api/session（会话管理）、POST /api/parse、POST /api/knowledge、
 * POST /api/tutor、POST /api/gap、GET /api/quiz、GET /api/health
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
  GapRequest,
  GapResponse,
  HealthResponse,
  KnowledgeRequest,
  KnowledgeResponse,
  Material,
  ParseRequest,
  ParseResponse,
  QuizResponse,
  QuizSource,
  Session,
  SupplementBlock,
  Topic,
  TutorRequest,
  TutorResponse,
} from '@lc/contracts';
import { MATERIAL_LIMITS, MATERIAL_QUIZ_PER_TOPIC } from '@lc/contracts';
import { env } from '../config/env.js';
import { createBudget, withBudget } from '../model/budget.js';
import { ModelError } from '../model/errors.js';
import { createModelAdapter } from '../model/index.js';
import { mapModelError } from './model-error-map.js';
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

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
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
    const body = (req.body ?? {}) as ParseRequest;
    const text = (body.text ?? '').trim();

    if (text.length === 0 && !body.imageBase64) {
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
      ...(body.imageBase64
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
    const body = (req.body ?? {}) as KnowledgeRequest;
    const session = requireSession(body.sessionId);
    const incoming: Material[] = body.materials ?? [];

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
    const body = (req.body ?? {}) as TutorRequest;
    const question = (body.question ?? '').trim();
    if (question.length === 0) {
      throw new ApiError('BAD_REQUEST', '请先输入问题');
    }

    // sessionId 为空表示轻路径（零材料）提问（说明书 2.1）
    let materials: MaterialSlice[] = [];
    let allowedRefs: AllowedRef[] = [];
    if (body.sessionId) {
      const session = requireSession(body.sessionId);
      assertVersion(session, body.materialVersion ?? session.materialVersion);
      materials = toSlices(session);
      allowedRefs = toAllowedRefs(session);
    }

    const result = await teaching.answerQuestion({
      question,
      mode: body.mode ?? 'explain',
      materials,
      ...(body.knowledgePointId ? { knowledgePointId: body.knowledgePointId } : {}),
      ...(body.recentAnswers ? { recentAnswers: body.recentAnswers } : {}),
    });

    // 假引用与越权内容不得作为正常答案展示（说明书 4.3、用例 E7）。
    // 零材料提问时学生主动提问即为授权，此时由 basedOnMaterial=false 承担标注责任。
    const { valid, rejected } = teaching.validateAnswerBlocks(result.blocks, allowedRefs, {
      requireAuthorization: body.sessionId !== null,
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
    const body = (req.body ?? {}) as GapRequest;
    const session = requireSession(body.sessionId);
    assertVersion(session, body.materialVersion);

    // 记下本次生成所基于的版本；模型调用期间（约 1—3 秒）可能有并发请求提交过，
    // 提交前须复核（说明书 9.3）
    const baseVersion = session.materialVersion;

    const existing = session.supplements.find(
      (supplement) => supplement.conceptId === body.conceptId,
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
      conceptId: body.conceptId,
      conceptName: body.conceptId,
      reason: body.reason,
      materials: toSlices(session),
    });

    const supplement: SupplementBlock = {
      id: randomUUID(),
      sessionId: session.id,
      conceptId: body.conceptId,
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
    const topic = req.query.topic as Topic | undefined;
    if (!topic) {
      throw new ApiError('BAD_REQUEST', '缺少 topic 参数');
    }

    const source = (req.query.source as QuizSource | undefined) ?? 'fixed';

    if (source === 'fixed') {
      const response: QuizResponse = { items: FIXED_QUIZ[topic] ?? [] };
      res.json(response);
      return;
    }

    // 按材料出题需要会话上下文（说明书 2.6）
    const sessionId = req.query.sessionId as string | undefined;
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

/* ==================== 统一错误处理 ==================== */

export function errorHandler(
  error: unknown,
  _req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  _next: Parameters<RequestHandler>[2],
): void {
  if (res.headersSent) {
    return;
  }

  if (error instanceof ApiError) {
    const body: ApiErrorBody = {
      error: { code: error.code, message: error.message, retryable: false },
    };
    res.status(error.status).json(body);
    return;
  }

  if (error instanceof SessionNotFoundError) {
    const body: ApiErrorBody = {
      error: { code: 'NOT_FOUND', message: error.message, retryable: false },
    };
    res.status(404).json(body);
    return;
  }

  // 提交前复核版本发现冲突：本次结果基于过期状态，已丢弃（说明书 9.3）
  // 与 /tutor、/gap 入口处的版本校验同为 SESSION_STALE，前端按 error.code 处理即可；
  // 这里用 409 而非 400，语义上更准确，且 retryable 为 true（基于最新状态重试）。
  if (error instanceof SessionVersionConflictError) {
    const body: ApiErrorBody = {
      error: { code: 'SESSION_STALE', message: error.message, retryable: true },
    };
    res.status(409).json(body);
    return;
  }

  // 模型错误统一映射（说明书 V1.4 第 9.3 节）：
  // 401 认证 / 429 额度 / 504 超时 / 502 上游 / 400 请求不合法。
  // 必须放在最后的兜底分支之前，否则模型故障会被一律吞成 500。
  if (error instanceof ModelError) {
    const mapped = mapModelError(error.code);
    const body: ApiErrorBody = {
      error: { code: mapped.code, message: error.message, retryable: mapped.retryable },
    };
    res.status(mapped.status).json(body);
    return;
  }

  // 兜底：AbortError 说明确实是超时；其余为未分类的服务器内部错误
  const isTimeout = error instanceof Error && error.name === 'AbortError';
  const body: ApiErrorBody = {
    error: {
      code: isTimeout ? 'MODEL_TIMEOUT' : 'INTERNAL',
      message: isTimeout
        ? '模型响应超过 60 秒，请重试（已保留你的输入）'
        : error instanceof Error
          ? error.message
          : '服务器内部错误',
      retryable: true,
    },
  };
  res.status(isTimeout ? 504 : 500).json(body);
}
