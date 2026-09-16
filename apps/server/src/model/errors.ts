import type { ModelErrorCode, ModelFailure } from '@calc/contracts';

/**
 * 适配层统一错误。
 *
 * 约定：进入 message 与 detail 的文本必须已经过 redact() 处理。
 * 目的是让错误可以安全地出现在服务端日志、接口响应，
 * 以及**参赛提交的 LearnBuddy 对话记录**中。
 */
export class ModelError extends Error implements ModelFailure {
  readonly code: ModelErrorCode;
  readonly detail: string | undefined;

  constructor(code: ModelErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.detail = detail;
  }

  /** 转为可直接返回给调用方的载荷 */
  toFailure(): ModelFailure {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

/**
 * 抹去文本中的密钥。
 *
 * 两重保险：① 已知密钥逐字替换；② 兜底匹配常见密钥前缀形态。
 * 第二重用于密钥未传入、但错误正文里仍出现凭证的情况。
 */
export function redact(text: unknown, secrets: readonly (string | undefined)[]): string {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out.replace(/\b(?:ck|sk)[_-][A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}
