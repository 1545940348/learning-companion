/**
 * 模型适配层：CodeBuddy Agent SDK
 *
 * 设计依据（均为实测事实，不作推测）：
 * 1. 认证不由 HTTP 地址与自定义 header 承担，而是 SDK 读取 CODEBUDDY_API_KEY
 *    与 CODEBUDDY_INTERNET_ENVIRONMENT=internal。因此本适配层没有 baseURL 之类的配置项。
 * 2. 模型名由上游默认选择，不硬编码。实测文字为 hy3、含图片为 hy4-preview-f，
 *    同一份代码按输入类型自动换档，所以模型名只能回读、不能预设。
 * 3. 输入沿用两条已验证形态：纯文字用字符串 prompt，含图片用 UserMessage 异步流。
 *    两条路径都已在 2026-09-16 实测通过，故不合并成一条未经实测的路径。
 *
 * 该层对外只暴露 @calc/contracts 的 ModelClient 接口，SDK 类型不外泄。
 * 若要更换调用方式（例如换成其他 SDK 或自建服务），只需替换本目录实现。
 */

import { query } from '@tencent-ai/agent-sdk';
import type {
  AuthEnvironment,
  ContentBlock,
  Message,
  Options,
  PermissionResult,
  UserMessage,
} from '@tencent-ai/agent-sdk';
import type {
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResult,
  ModelSelfCheckResult,
  ModelUsage,
} from '@calc/contracts';
import { ModelError, redact } from './errors.js';

export const PROVIDER_ID = 'codebuddy-agent-sdk';
export const DEFAULT_ENVIRONMENT: AuthEnvironment = 'internal';
/** 对应说明书 5.3：模型请求超过 60 秒报错，可重试并保留输入 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** 对应说明书 2.1：单张图片不超过 5MB */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_ENVIRONMENTS: readonly string[] = ['external', 'internal', 'ioa', 'cloudhosted'];

/**
 * 需要从子进程环境中清空的中转变量。
 * 理由：宿主环境可能已配置账号、端点或模型覆盖，会让本适配层的配置"看起来生效、实际被遮蔽"。
 * 显式清空后，本次调用的凭证与环境完全由本适配层决定。
 */
const RELAY_KEYS = [
  'CODEBUDDY_AUTH_TOKEN',
  'CODEBUDDY_BASE_URL',
  'CODEBUDDY_CUSTOM_HEADERS',
  'CODEBUDDY_MODEL',
] as const;

export interface WorkbuddyModelConfig {
  /** 凭证；默认读取 process.env.CODEBUDDY_API_KEY */
  apiKey?: string;
  /** 上游环境；默认读取 CODEBUDDY_INTERNET_ENVIRONMENT，缺省 internal */
  environment?: AuthEnvironment;
  /** 默认超时（毫秒）；默认读取 MODEL_TIMEOUT_MS，缺省 60000 */
  timeoutMs?: number;
  /** SDK 子进程工作目录 */
  cwd?: string;
  /** 显式指定模型。默认不指定，采用上游按输入类型自动选择。 */
  model?: string;
  /** 调试日志出口；默认静默 */
  log?: (line: string) => void;
}

function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

function readEnvironment(): AuthEnvironment {
  const raw = readEnv('CODEBUDDY_INTERNET_ENVIRONMENT');
  return ALLOWED_ENVIRONMENTS.includes(raw) ? (raw as AuthEnvironment) : DEFAULT_ENVIRONMENT;
}

function readTimeoutMs(): number {
  const parsed = Number(readEnv('MODEL_TIMEOUT_MS'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** 纯文字输入：拼接为一个字符串 prompt */
function joinText(content: readonly ModelContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n\n');
}

/** 含图片输入：构造单条 UserMessage，走已验证的异步流形态 */
async function* toUserMessageStream(content: readonly ModelContentBlock[]): AsyncGenerator<UserMessage> {
  const blocks: ContentBlock[] = content.map((block): ContentBlock =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
        },
  );
  yield {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: blocks },
  };
}

/** 把上游抛出的任意错误归一为可判定的 ModelError；detail 已脱敏 */
function classify(error: unknown, aborted: boolean, timeoutMs: number, secret: string): ModelError {
  const detail = redact(error instanceof Error ? error.message : String(error), [secret]);
  if (aborted) {
    return new ModelError('TIMEOUT', `模型调用超过 ${timeoutMs} 毫秒未返回，已中止，可重试。`, detail);
  }
  if (/unauthor|forbidden|invalid[_ -]?api|authentication|credential|\b401\b|\b403\b/i.test(detail)) {
    return new ModelError('AUTH', '模型认证失败。请确认 CODEBUDDY_API_KEY 与运行环境是否匹配。', detail);
  }
  if (/quota|insufficient|balance|额度|余额/i.test(detail)) {
    return new ModelError('QUOTA', '模型额度或余额不足。', detail);
  }
  return new ModelError('UPSTREAM', '模型调用失败。', detail);
}

export function createWorkbuddyModelClient(config: WorkbuddyModelConfig = {}): ModelClient {
  const apiKey = (config.apiKey ?? readEnv('CODEBUDDY_API_KEY')).trim();
  const environment = config.environment ?? readEnvironment();
  const timeoutMs = config.timeoutMs ?? readTimeoutMs();
  const cwd = config.cwd ?? process.cwd();
  const explicitModel = config.model;
  const log = config.log ?? ((): void => {});

  function childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CODEBUDDY_INTERNET_ENVIRONMENT: environment,
      CODEBUDDY_API_KEY: apiKey,
    };
    for (const key of RELAY_KEYS) env[key] = '';
    return env;
  }

  async function complete(request: ModelRequest): Promise<ModelResult> {
    if (!apiKey) {
      throw new ModelError('AUTH', '缺少 CODEBUDDY_API_KEY，无法发起模型调用。请参考 .env.example 配置。');
    }
    if (!request.content.length) {
      throw new ModelError('INVALID_REQUEST', '模型调用的 content 为空。');
    }

    const hadImage = request.content.some((block) => block.type === 'image');
    const effectiveTimeout = request.timeoutMs ?? timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    const startedAt = Date.now();

    const options: Options = {
      // 教学运行时是只读的：禁用全部内置工具、不接 MCP、不加载任何外部配置来源
      tools: [],
      mcpServers: {},
      settingSources: [],
      canUseTool: async (): Promise<PermissionResult> => ({
        behavior: 'deny',
        message: '教学运行时禁止执行任何工具。',
      }),
      // 单轮、不落盘：会话与材料版本由服务端按说明书 5.3 自行维护，不依赖 SDK 会话
      maxTurns: 1,
      persistSession: false,
      cwd,
      env: childEnv(),
      abortController: controller,
      stderr: (): void => {},
    };
    if (request.systemPrompt) options.systemPrompt = request.systemPrompt;
    if (request.jsonSchema) {
      options.outputFormat = { type: 'json_schema', schema: request.jsonSchema };
    }
    if (explicitModel) options.model = explicitModel;

    const prompt: string | AsyncIterable<UserMessage> = hadImage
      ? toUserMessageStream(request.content)
      : joinText(request.content);

    try {
      log(
        `[model] 调用开始 purpose=${request.purpose ?? '-'} 含图片=${String(hadImage)} ` +
          `结构化=${String(Boolean(request.jsonSchema))} 超时=${effectiveTimeout}ms 环境=${environment}`,
      );

      let reportedModel = '';
      const texts: string[] = [];
      let structured: unknown;
      let usage: ModelUsage | undefined;
      let sawResult = false;

      for await (const message of query({ prompt, options }) as AsyncIterable<Message>) {
        if (message.type === 'system' && message.subtype === 'init') {
          reportedModel = message.model || reportedModel;
          continue;
        }
        if (message.type === 'assistant') {
          if (message.message.model) reportedModel = message.message.model;
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) texts.push(block.text);
          }
          const turnUsage = message.message.usage;
          if (turnUsage) {
            usage = { inputTokens: turnUsage.input_tokens, outputTokens: turnUsage.output_tokens };
          }
          continue;
        }
        if (message.type === 'result') {
          sawResult = true;
          if (message.subtype !== 'success') {
            throw new ModelError(
              'UPSTREAM',
              `模型执行失败（${message.subtype}）。`,
              message.errors?.join('; '),
            );
          }
          if (message.is_error) {
            throw new ModelError('UPSTREAM', '上游报告本次调用出错。', message.result);
          }
          if (message.structured_output !== undefined) structured = message.structured_output;
          if (!texts.length && message.result) texts.push(message.result);
          usage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            totalCostUsd: message.total_cost_usd,
          };
        }
      }

      if (!sawResult) {
        throw new ModelError('UPSTREAM', '模型未返回 result 消息，本次调用未完成。');
      }
      if (!texts.length && structured === undefined) {
        throw new ModelError('UPSTREAM', '模型返回内容为空。');
      }

      const durationMs = Date.now() - startedAt;
      const result = {
        text: texts.join('\n'),
        model: reportedModel,
        durationMs,
        hadImage,
        ...(structured === undefined ? {} : { structuredOutput: structured }),
        ...(usage === undefined ? {} : { usage }),
      } satisfies ModelResult;

      log(`[model] 调用成功 模型=${reportedModel || '上游未报告'} 耗时=${durationMs}ms`);
      return result;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw classify(error, controller.signal.aborted, effectiveTimeout, apiKey);
    } finally {
      clearTimeout(timer);
    }
  }

  function selfCheck(): ModelSelfCheckResult {
    const problems: string[] = [];
    const warnings: string[] = [];

    if (!apiKey) {
      problems.push('缺少 CODEBUDDY_API_KEY（见 .env.example）。');
    } else if (!/^(?:ck|sk)[_-]/.test(apiKey)) {
      warnings.push('密钥前缀不是 ck_/sk_，请确认没有误用其他平台的凭证。');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      problems.push('MODEL_TIMEOUT_MS 必须为正数。');
    }
    const rawEnvironment = readEnv('CODEBUDDY_INTERNET_ENVIRONMENT');
    if (rawEnvironment && rawEnvironment !== environment) {
      warnings.push(
        `CODEBUDDY_INTERNET_ENVIRONMENT="${rawEnvironment}" 不在允许取值内，已回退为 ${DEFAULT_ENVIRONMENT}。`,
      );
    }
    if (explicitModel) {
      warnings.push(`已显式指定模型 ${explicitModel}，将不采用上游按输入类型的默认选择。`);
    }

    return {
      ok: problems.length === 0,
      provider: PROVIDER_ID,
      environment,
      credentialPresent: Boolean(apiKey),
      timeoutMs,
      problems,
      warnings,
    };
  }

  return { complete, selfCheck };
}
