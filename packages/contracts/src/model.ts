/**
 * 模型调用共享接口
 *
 * 这是 B（教学智能）唯一需要依赖的模型层接口，由 C 实现并注入。
 * 本文件刻意不出现任何 SDK、HTTP 或厂商字段：模型如何被调用属于 C 的实现细节，
 * 更换调用方式不应导致 B 的代码发生变化。
 */

/** 模型输入的内容块。文本与图片可混合，顺序即模型看到的顺序。 */
export type ModelContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      /** 仅接受说明书 2.1 允许的两种格式 */
      readonly mediaType: 'image/png' | 'image/jpeg';
      readonly dataBase64: string;
    };

/** 一次模型调用的输入。无会话状态：每次调用相互独立。 */
export interface ModelRequest {
  /** 系统提示词，由教学模块提供 */
  readonly systemPrompt?: string;
  /** 按顺序拼接的内容；不允许为空 */
  readonly content: readonly ModelContentBlock[];
  /**
   * 结构化输出 schema。提供后模型被约束按该 schema 返回，结果见 ModelResult.structuredOutput。
   * 用途：来源分类、依赖判定等需要稳定字段的场合，避免用正则解析自由文本。
   */
  readonly jsonSchema?: Record<string, unknown>;
  /** 本次调用超时（毫秒）；不填则使用配置默认值，默认 60000，对应说明书 5.3 */
  readonly timeoutMs?: number;
  /** 调用用途标记，仅用于日志与开发留痕，不改变模型行为 */
  readonly purpose?: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 上游报告的美元成本；上游不提供时为 undefined */
  readonly totalCostUsd?: number;
}

/** 一次模型调用的输出。 */
export interface ModelResult {
  /** 模型返回的正文 */
  readonly text: string;
  /** 结构化输出；仅在请求了 jsonSchema 且上游返回时存在 */
  readonly structuredOutput?: unknown;
  /**
   * 本次调用实际使用的模型名，由上游报告而非调用方指定。
   * 上游可能按输入类型自动换档（纯文字与含图片使用不同模型），因此不得硬编码。
   */
  readonly model: string;
  readonly durationMs: number;
  readonly usage?: ModelUsage;
  /** 本次输入是否包含图片 */
  readonly hadImage: boolean;
}

/**
 * 模型调用失败的原因分类。分类存在的目的：
 * 前端与教学模块需要据此给出不同的下一步（重试 / 报错 / 引导），而不是一律 500。
 */
export type ModelErrorCode =
  /** 认证失败或缺少凭证 */
  | 'AUTH'
  /** 超过配置的超时时间 */
  | 'TIMEOUT'
  /** 额度或余额不足 */
  | 'QUOTA'
  /** 请求本身不合法（空内容、非法参数） */
  | 'INVALID_REQUEST'
  /** 上游执行失败 */
  | 'UPSTREAM';

/** 适配层对外的统一错误载荷。detail 已做密钥脱敏，可安全进入日志与开发文档。 */
export interface ModelFailure {
  readonly code: ModelErrorCode;
  readonly message: string;
  readonly detail?: string;
}

/** 适配层自检结果。不发起模型调用，不消耗额度。 */
export interface ModelSelfCheckResult {
  readonly ok: boolean;
  /** 适配器标识，例如 codebuddy-agent-sdk */
  readonly provider: string;
  /** 上游环境标识，例如 internal */
  readonly environment: string;
  readonly credentialPresent: boolean;
  readonly timeoutMs: number;
  /** 阻塞性问题；非空即 ok=false */
  readonly problems: readonly string[];
  /** 非阻塞提醒，不影响 ok */
  readonly warnings: readonly string[];
}

/** 模型调用客户端。B 通过该接口调用模型，不感知具体实现。 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResult>;
  selfCheck(): ModelSelfCheckResult;
}
