/**
 * 模型错误 → HTTP 响应的统一映射（说明书 V1.4 第 9.3 节）
 *
 * 要求原文：
 * > 「教学 JSON 解析与字段／引用校验仍需完善；**错误层未完整映射模型错误**」
 * > → **C 负责**：统一映射认证、额度、超时与上游错误。
 *
 * ### 设计取舍：不新增 `ApiErrorCode` 取值
 *
 * `ApiErrorCode` 属于 `packages/contracts` 的契约类型，增加取值需要 A、B 同步修改，
 * 而 V1.4 要求"避免文档、前端和服务端分叉"。因此：
 *
 * - 契约层只区分 `MODEL_TIMEOUT`（超时）与 `MODEL_ERROR`（其他模型故障）；
 * - **细分类别由 HTTP 状态码承载**（401 认证 / 429 额度 / 504 超时 / 502 上游 / 400 请求不合法）。
 *
 * 前端据此只需要看两件事：`error.retryable` 决定要不要给"一键重试"，
 * 状态码决定提示文案。
 *
 * 本模块是纯函数查表，不依赖 express，可直接单测。
 */

import type { ApiErrorCode, ModelErrorCode } from '@lc/contracts';

export interface ModelErrorResponse {
  /** HTTP 状态码 */
  readonly status: number;
  /** 契约里已有的错误码，不新增取值 */
  readonly code: ApiErrorCode;
  /** 前端是否可以"一键重试" */
  readonly retryable: boolean;
}

const MODEL_ERROR_MAP: Readonly<Record<ModelErrorCode, ModelErrorResponse>> = {
  /** 认证失败或缺少凭证：重试无用，需要修服务端配置 */
  AUTH: { status: 401, code: 'MODEL_ERROR', retryable: false },
  /** 额度或余额不足：重试无用，需要充值或换账号 */
  QUOTA: { status: 429, code: 'MODEL_ERROR', retryable: false },
  /** 超时：说明书 5.3 要求"可重试并保留输入" */
  TIMEOUT: { status: 504, code: 'MODEL_TIMEOUT', retryable: true },
  /** 上游执行失败：多为瞬时故障，可重试 */
  UPSTREAM: { status: 502, code: 'MODEL_ERROR', retryable: true },
  /** 请求本身不合法：属于我们自己的缺陷，需修代码，不是重试能解决的 */
  INVALID_REQUEST: { status: 400, code: 'MODEL_ERROR', retryable: false },
};

/** 查表；`ModelErrorCode` 是闭合联合，因此必定命中 */
export function mapModelError(code: ModelErrorCode): ModelErrorResponse {
  return MODEL_ERROR_MAP[code];
}
