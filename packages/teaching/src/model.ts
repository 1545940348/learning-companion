/**
 * 模型调用函数由外部（C 所在的 apps/server）注入。
 *
 * 教学模块自身不读取密钥、不直接访问网络、不依赖任何托管平台（说明书 7.2），
 * 因此可以在没有真实密钥的情况下被测试。
 */

export interface ModelCallOptions {
  /** 系统提示词 */
  system?: string;
  /** 要求返回 JSON；实现方应尽量启用结构化输出 */
  json?: boolean;
  /** 覆盖默认超时（默认 MODEL_TIMEOUT_MS，60 秒） */
  timeoutMs?: number;
}

/** 返回模型的原始文本输出 */
export type ModelCaller = (prompt: string, options?: ModelCallOptions) => Promise<string>;
