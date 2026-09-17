/**
 * 单次业务请求的模型调用预算（说明书 V1.4）
 *
 * 要求原文：
 * > 保留单次业务请求 60 秒总预算；**重试计入同一预算**，
 * > 超时返回可重试错误并保留输入。记录真实耗时；更换供应商不等于已解决超时。
 *
 * ### 做法
 *
 * 请求进入时开一个预算（默认取 `MODEL_TIMEOUT_MS`）。之后**每一次**模型调用拿到的
 * 超时都是【剩余时间】，而不是各自重新计 60 秒。因此即使一个请求调用多次模型
 * （包含重试），总耗时也不会突破预算。
 *
 * ### 为什么放在这一层
 *
 * 教学模块（B 的）是"调用模型"的那一层，`ModelCaller` 是它与模型层之间的唯一接口。
 * 把预算包在 `ModelCaller` 外面，就既能让预算作用到每一次调用，
 * 又**不需要改动教学模块的任何代码**。
 *
 * ### 边界
 *
 * 本模块不感知 HTTP、不读环境变量、不发起网络请求，全部逻辑是纯计算 + 包装调用，
 * 因此可以直接用假调用函数单测（见 scripts/verify-error-mapping.mjs）。
 */

import type { ModelCaller, ModelCallOptions, ModelInput } from '@lc/teaching';
import type { ModelErrorCode } from '@lc/contracts';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { ModelError, redact } from './errors.js';

/** 剩余不足这个量就不值得再试一次（一次调用的固有开销约在这个量级） */
export const MIN_RETRY_REMAINING_MS = 5_000;

/** 最多重试次数（说明书 V1.4 要求"须限制次数"） */
export const MAX_RETRIES = 1;

/**
 * 唯一允许重试的错误类型：**上游瞬时故障**。
 *
 * 其余四类重试没有意义，理由各不相同：
 * - `AUTH`：凭证错，重试一百次结果一样
 * - `QUOTA`：额度空，重试只会再失败一次
 * - `INVALID_REQUEST`：我们自己的请求有问题，重试等于把同一个错发两遍
 * - `TIMEOUT`：预算通常已耗尽，没有余量（也由下面的剩余量检查兜住）
 */
const RETRYABLE_CODES: readonly ModelErrorCode[] = ['UPSTREAM'];

export interface Budget {
  /** 预算总量（毫秒） */
  readonly totalMs: number;
  /** 预算起点（epoch 毫秒） */
  readonly startedAt: number;
  /** 已发起的调用次数（含重试），仅用于日志与重试判定 */
  attempts: number;
}

export function createBudget(totalMs: number, now: number = Date.now()): Budget {
  return { totalMs, startedAt: now, attempts: 0 };
}

/** 剩余可用时间；已耗尽时为 0，**绝不为负** */
export function remainingMs(budget: Budget, now: number = Date.now()): number {
  return Math.max(0, budget.totalMs - (now - budget.startedAt));
}

/**
 * 是否值得重试。
 *
 * 三个条件同时满足才行：错误类型可重试、重试次数没用完、剩余预算够再跑一次。
 */
export function canRetry(error: unknown, budget: Budget, now: number = Date.now()): boolean {
  if (!(error instanceof ModelError)) return false;
  if (!RETRYABLE_CODES.includes(error.code)) return false;
  // attempts 在发起调用前已自增，故此处用 > MAX_RETRIES 判断"重试次数是否已用完"
  if (budget.attempts > MAX_RETRIES) return false;
  return remainingMs(budget, now) >= MIN_RETRY_REMAINING_MS;
}

/**
 * 给 `ModelCaller` 套上「同一预算内调用 + 受控重试 + 结构化日志」。
 *
 * 返回的函数与入参**签名完全一致**，因此教学模块无需任何改动即可受益。
 *
 * 超时处理：调用方若显式传了 `timeoutMs`，也要受总预算约束 —— 取两者较小值。
 */
export function withBudget(
  call: ModelCaller,
  budget: Budget,
  logger: Logger = defaultLogger,
): ModelCaller {
  // 文案里的秒数取自预算本身，不写死 60 —— 否则把 MODEL_TIMEOUT_MS 调小做验证时，
  // 日志与前端提示还在说"60 秒"，反而让人以为预算没生效。
  const budgetSeconds = Math.max(1, Math.round(budget.totalMs / 1000));

  return async (input: ModelInput, options?: ModelCallOptions): Promise<string> => {
    // 循环而非递归，次数由 canRetry 控制，最多两轮
    for (;;) {
      const left = remainingMs(budget);
      if (left <= 0) {
        throw new ModelError(
          'TIMEOUT',
          `本次请求的 ${budgetSeconds} 秒总预算已用尽，请重试（已保留你的输入）。`,
        );
      }

      budget.attempts += 1;
      const attempt = budget.attempts;
      const timeoutMs = Math.min(options?.timeoutMs ?? left, left);
      const startedAt = Date.now();
      const hasImage = Array.isArray(input);

      logger.info('model.call.start', {
        attempt,
        timeoutMs,
        remainingMs: left,
        json: Boolean(options?.json),
        hasImage,
      });

      try {
        const text = await call(input, { ...options, timeoutMs });
        logger.info('model.call.ok', {
          attempt,
          durationMs: Date.now() - startedAt,
          remainingMs: remainingMs(budget),
        });
        return text;
      } catch (error) {
        const code: ModelErrorCode | 'UNEXPECTED' =
          error instanceof ModelError ? error.code : 'UNEXPECTED';
        const retrying = canRetry(error, budget);

        logger.error('model.call.fail', {
          attempt,
          durationMs: Date.now() - startedAt,
          remainingMs: remainingMs(budget),
          code,
          retrying,
          // redact 无已知密钥时仍会兜底抹去常见密钥前缀形态
          message: redact(error, []).slice(0, 200),
        });

        if (!retrying) throw error;
      }
    }
  };
}
