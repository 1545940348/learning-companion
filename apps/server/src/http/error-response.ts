/**
 * 错误 → HTTP 响应的唯一事实来源（说明书 5.3、V1.4 第 9.3 节）
 *
 * ### 为什么单独成文件
 *
 * 原先 `errorHandler` 的各个分支**各自写死** `retryable`，于是同一个契约错误码
 * 在两条路径上给出了不同答案：`SESSION_STALE` 在入口版本校验时是「400 + 不可重试」，
 * 在提交前复核时是「409 + 可重试」。前端 `apps/web/src/api.ts` 只凭 `retryable`
 * 决定要不要给"一键重试"，这种分叉会直接传导成学生端行为不一致 ——
 * 明明是同一件事（结果基于过期状态），一处能重试、一处不能。
 *
 * 因此把「错误码 → 状态码 / retryable」收敛为**一张表**：
 * 需要判断时查表，不在分支里写 if。
 *
 * 本模块是纯函数查表，不依赖 express，可直接单测
 * （见 scripts/verify-guards-and-errors.mjs）。
 */

import type { ApiErrorCode } from '@lc/contracts';

/**
 * 前端可以"一键重试"的契约错误码。**只有这两个**。
 *
 * - `SESSION_STALE`：结果基于过期状态被丢弃，基于最新状态重试即可（说明书 5.3）
 * - `MODEL_TIMEOUT`：说明书 5.3 明确要求"可重试并保留输入"
 *
 * 其余一律不可重试，理由各不相同：`BAD_REQUEST` 是我们的入参问题，
 * `UNAUTHORIZED_CONTENT` 是内容越权，`NOT_FOUND` 重试也不会出现，
 * `MODEL_ERROR` 覆盖认证／额度／请求不合法（重试无意义），
 * `INTERNAL` 说明我们有缺陷 —— 让前端给学生"再试一次"是误导。
 */
const RETRYABLE_API_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'SESSION_STALE',
  'MODEL_TIMEOUT',
]);

export function isRetryableApiCode(code: ApiErrorCode): boolean {
  return RETRYABLE_API_CODES.has(code);
}

/**
 * 契约错误码的默认 HTTP 状态码。
 *
 * 取舍：`packages/contracts` 的 `ApiErrorCode` 不再细分取值，
 * **细分类别由状态码承载**，所以这张表是"细分"的落点，必须与契约注释一致。
 */
const API_CODE_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  BAD_REQUEST: 400,
  /** 内容越权：不得作为正常答案展示（用例 E7） */
  UNAUTHORIZED_CONTENT: 403,
  NOT_FOUND: 404,
  /** 版本不匹配：与提交复核同一状态码，两条路径不得分叉 */
  SESSION_STALE: 409,
  /** 上游故障（认证／额度／请求不合法由具体状态码承载，这里是兜底） */
  MODEL_ERROR: 502,
  MODEL_TIMEOUT: 504,
  /** 路径存在但功能未交付（如阶段三的教师视图），不得用空数据冒充 */
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};

export function defaultStatusForApiCode(code: ApiErrorCode): number {
  return API_CODE_STATUS[code];
}

/** 传输层（express.json 等）错误的统一响应 */
export interface TransportErrorResponse {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
}

/**
 * `express.json()` 抛出的解析错误 → 统一响应。
 *
 * 必须处理的理由：解析失败原本会一路落到兜底分支，变成 **500 `INTERNAL`**，
 * 而它其实是**客户端**把 body 写坏了，应当是 400。
 * 两个错处叠加：状态码错了，前端还会因为 `INTERNAL` 被标成可重试而给出"一键重试"，
 * 点一次错一次。
 *
 * 注意**不能**把解析器的 message 回给客户端（形如
 * `Expected property name or '}' in JSON at position 1`），那属于实现细节。
 */
export function classifyBodyError(error: unknown): TransportErrorResponse | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { status?: unknown; type?: unknown };
  if (typeof candidate.type !== 'string' || !candidate.type.startsWith('entity.')) {
    return null;
  }
  if (candidate.type === 'entity.too.large') {
    // 契约里没有专门的大体积错误码，不为此新增取值，统一按 BAD_REQUEST 表达
    return {
      status: 413,
      code: 'BAD_REQUEST',
      message: '请求体过大：图片请压缩到 5MB 以内后重试。',
    };
  }
  return { status: 400, code: 'BAD_REQUEST', message: '请求体不是合法的 JSON。' };
}
