/**
 * 环境变量读取与校验。
 *
 * 密钥只存在于服务端，绝不进入前端或仓库（说明书 5.1）。
 * 本地开发从 apps/server/.env 读取（cwd 为 apps/server）；
 * 线上部署直接用环境变量注入，不依赖 .env 文件。
 *
 * 默认通道：**DeepSeek API**（说明书 V1.4）。
 * 由 C 维护的 HTTP 适配器 `apps/server/src/model/deepseek.ts` 向 B 提供统一 `ModelCaller`。
 *
 * 历史接入：CodeBuddy Agent SDK（`apps/server/src/model/workbuddy.ts`）。
 * 代码保留，但**不参与自动降级** —— 必须显式设置 `MODEL_PROVIDER=sdk` 才会启用。
 *
 * 说明书 V1.4 的三条硬性要求，本文件逐一落实：
 * 1. 默认通道为 deepseek（`auto` 档已取消，避免"隐性偏向 SDK"）；
 * 2. 缺少密钥或模型失败时**明确报错**，不静默切 SDK 或 mock；
 * 3. 启动日志与 `GET /api/health` 如实报告实际适配器，不把 DS 调用标成 LearnBuddy 能力。
 */

import { config } from 'dotenv';

config();

/** 上游环境，与 SDK 的 AuthEnvironment 取值保持一致 */
export type CodebuddyEnvironment = 'external' | 'internal' | 'ioa' | 'cloudhosted';

/**
 * 模型通道。**没有 `auto` 档** —— 说明书 V1.4 要求默认即为 deepseek，
 * 而 `auto` 会因有无 SDK 密钥而在两个通道间摇摆，正是 V1.4 要消除的不确定行为。
 */
export type ModelProvider = 'deepseek' | 'sdk' | 'mock';

const VALID_PROVIDERS: readonly ModelProvider[] = ['deepseek', 'sdk', 'mock'];

/** 说明书 V1.4：默认通道为 DeepSeek */
const DEFAULT_PROVIDER: ModelProvider = 'deepseek';

export interface Env {
  port: number;
  nodeEnv: string;

  /** 实际生效的通道 */
  channel: ModelProvider;
  /** 模型请求超时（毫秒），默认 60000（说明书 5.3） */
  modelTimeoutMs: number;

  /** 默认通道：DeepSeek */
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;

  /** 历史接入：CodeBuddy Agent SDK */
  codebuddyApiKey: string;
  codebuddyEnvironment: CodebuddyEnvironment;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readText(raw: string | undefined): string {
  return (raw ?? '').trim();
}

const ENVIRONMENTS: readonly string[] = ['external', 'internal', 'ioa', 'cloudhosted'];

function readEnvironment(raw: string | undefined): CodebuddyEnvironment {
  const value = (raw ?? '').trim();
  return ENVIRONMENTS.includes(value) ? (value as CodebuddyEnvironment) : 'internal';
}

/**
 * 配置层面的阻塞性问题。
 *
 * 与"运行时的模型失败"严格区分：
 * - 这里是**配置不对**（取值非法、缺密钥）→ 启动时汇总报告，不静默兜底；
 * - 运行时失败（网络、超时、401）由适配层捕获并抛 ModelError，不会崩主进程。
 */
const configProblems: string[] = [];

function readProvider(raw: string | undefined): ModelProvider {
  const value = (raw ?? '').trim();
  if (value.length === 0) return DEFAULT_PROVIDER;
  if ((VALID_PROVIDERS as readonly string[]).includes(value)) return value as ModelProvider;

  configProblems.push(
    `MODEL_PROVIDER="${value}" 不是有效取值（有效：${VALID_PROVIDERS.join(' / ')}）。` +
      `说明书 V1.4 起默认即为 deepseek，已取消 auto 档 —— 请显式改为其中之一。`,
  );
  return DEFAULT_PROVIDER;
}

export function readEnv(): Env {
  const channel = readProvider(process.env.MODEL_PROVIDER);
  const deepseekModel = readText(process.env.DEEPSEEK_MODEL);

  return {
    port: readNumber(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',

    channel,
    // 默认 60 秒，对应说明书 5.3；重试须计入同一预算（说明书 V1.4）
    modelTimeoutMs: readNumber(process.env.MODEL_TIMEOUT_MS, 60_000),

    deepseekApiKey: readText(process.env.DEEPSEEK_API_KEY),
    deepseekBaseUrl: readText(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com',
    // 型号必须由配置给出：说明书 V1.4 规定"已有代码中的默认型号不是验证依据"，
    // 因此这里不再内置型号，避免把未经验证的值当作可用配置。
    deepseekModel,

    codebuddyApiKey: readText(process.env.CODEBUDDY_API_KEY),
    codebuddyEnvironment: readEnvironment(process.env.CODEBUDDY_INTERNET_ENVIRONMENT),
  };
}

export const env = readEnv();

/**
 * 启动日志用。让"本次运行的通道"一目了然 ——
 * 不把 DS 调用标成 LearnBuddy 能力，也不把 mock 说成真实能力（说明书 V1.4、9.2）。
 */
export function describeModelAdapter(): string {
  switch (env.channel) {
    case 'deepseek':
      return `model=deepseek（默认通道）base=${env.deepseekBaseUrl} id=${env.deepseekModel || '(未配置型号)'}`;
    case 'sdk':
      return `model=codebuddy-agent-sdk（历史接入，需显式启用）env=${env.codebuddyEnvironment}`;
    default:
      return 'model=mock（仅供本地开发，不调用真实模型）';
  }
}

/**
 * 启动前校验。返回**阻塞性问题**清单，空数组表示可以启动。
 *
 * 有问题时由调用方（src/index.ts）打印后明确退出 —— 这不是"崩溃"，是配置不完整时的
 * 主动拒绝启动；按说明书 V1.4，此时不得静默切到 SDK 或 mock。
 */
export function validateModelConfig(): string[] {
  const problems = [...configProblems];

  if (env.channel === 'deepseek') {
    if (env.deepseekApiKey.length === 0) {
      problems.push(
        '缺少 DEEPSEEK_API_KEY，默认通道无法调用。请在 apps/server/.env 配置；' +
          '若只想本地开发，请显式设 MODEL_PROVIDER=mock。',
      );
    }
    if (env.deepseekModel.length === 0) {
      problems.push('DEEPSEEK_MODEL 为空，无法确定调用哪个型号。请填写账号下真实可用的型号。');
    }
  }

  if (env.channel === 'sdk' && env.codebuddyApiKey.length === 0) {
    problems.push('已显式启用 sdk 通道，但缺少 CODEBUDDY_API_KEY。');
  }

  return problems;
}
