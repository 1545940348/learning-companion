/**
 * 模型调用函数由外部（C 所在的 apps/server）注入。
 *
 * 教学模块自身不读取密钥、不直接访问网络、不依赖任何托管平台（说明书 7.2），
 * 因此可以在没有真实密钥的情况下被测试。
 */

/** 文本内容块 */
export interface TextInputBlock {
  type: 'text';
  text: string;
}

/**
 * 图片内容块。
 * 仅接受说明书 2.1 允许的两种格式；dataBase64 为不含 data URI 前缀的原始 base64。
 */
export interface ImageInputBlock {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg';
  dataBase64: string;
}

export type ModelInputBlock = TextInputBlock | ImageInputBlock;

/**
 * 模型输入。两种写法都支持：
 * - `string`：纯文本。绝大多数调用点用这种写法，**保持向后兼容，无需改动**。
 * - `ModelInputBlock[]`：需要携带讲义图片时使用，对应说明书 2.1 图文输入与 B1 图文解析。
 *
 * 之所以做成联合类型而不是直接改成数组：现有调用点全部传字符串，
 * 改成数组会波及教学模块多处代码，违背最小改动原则。
 */
export type ModelInput = string | ModelInputBlock[];

export interface ModelCallOptions {
  /** 系统提示词 */
  system?: string;
  /**
   * 要求返回 JSON。
   *
   * ⚠️ 实现方**只能把 JSON 要求注入提示词**，无法强制上游按 schema 返回：
   * 2026-09-16 两次实测（跨两个模型）确认 `outputFormat` 不被兑现，
   * 详见 `docs/tech/2026-09-16-模型接入-CodeBuddy Agent SDK.md` 第四章。
   * 调用方仍需自行解析与校验，并准备重试。
   */
  json?: boolean;
  /** 覆盖默认超时（默认 MODEL_TIMEOUT_MS，60 秒） */
  timeoutMs?: number;
}

/** 返回模型的原始文本输出 */
export type ModelCaller = (input: ModelInput, options?: ModelCallOptions) => Promise<string>;
