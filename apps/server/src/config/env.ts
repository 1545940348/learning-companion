/**
 * 环境变量读取与校验。
 *
 * 密钥只存在于服务端，绝不进入前端或仓库（说明书 5.1）。
 * 本地开发从 apps/server/.env 读取（cwd 为 apps/server）；
 * 线上部署直接用环境变量注入，不依赖 .env 文件。
 *
 * 主通道：CodeBuddy Agent SDK（见 docs/tech/2026-09-16-模型接入-CodeBuddy Agent SDK.md）。
 * 认证由 SDK 读取环境变量完成，**没有 base URL，也没有固定模型名** ——
 * 模型由上游动态分配（同日实测 hy3 / glm-5.3 / minimax-m3 等多个结果，只能从响应回读），
 * 因此这里没有 MODEL_BASE_URL / MODEL_NAME。
 *
 * 备选通道：DeepSeek（第三方）。合规边界见 docs/tech/2026-09-17-模型通道-主路与备选.md。
 */

import { config } from 'dotenv';

config();

/** 上游环境，与 SDK 的 AuthEnvironment 取值保持一致 */
export type CodebuddyEnvironment = 'external' | 'internal' | 'ioa' | 'cloudhosted';

/**
 * 通道选择。
 * - `auto`（默认）：有 LearnBuddy 密钥走主通道，无密钥降级为 mock
 * - `mock`：强制 mock，不调用任何真实模型
 * - `sdk`：强制主通道（LearnBuddy）；无密钥时**不静默降级**
 * - `deepseek`：强制备选通道（第三方）。**最终效果呈现不得启用**，见文件头说明
 */
export type ModelProvider = 'auto' | 'mock' | 'sdk' | 'deepseek';

/** 实际生效的通道 */
export type ModelChannel = 'mock' | 'sdk' | 'deepseek';

export interface Env {
  port: number;
  nodeEnv: string;

  /** 主通道凭证：参赛账号密钥，仅服务端持有 */
  codebuddyApiKey: string;
  codebuddyEnvironment: CodebuddyEnvironment;

  /** 备选通道（第三方）配置 */
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;

  modelProvider: ModelProvider;
  modelTimeoutMs: number;
  /** 实际生效的通道，由模型配置推导 */
  channel: ModelChannel;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProvider(raw: string | undefined): ModelProvider {
  return raw === 'mock' || raw === 'sdk' || raw === 'deepseek' || raw === 'auto' ? raw : 'auto';
}

const ENVIRONMENTS: readonly string[] = ['external', 'internal', 'ioa', 'cloudhosted'];

function readEnvironment(raw: string | undefined): CodebuddyEnvironment {
  const value = (raw ?? '').trim();
  return ENVIRONMENTS.includes(value) ? (value as CodebuddyEnvironment) : 'internal';
}

function readText(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : fallback;
}

export function readEnv(): Env {
  const codebuddyApiKey = (process.env.CODEBUDDY_API_KEY ?? '').trim();
  const deepseekApiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  const modelProvider = readProvider(process.env.MODEL_PROVIDER);

  // 唯一的隐式降级：auto 且无主通道密钥时走 mock。
  // 这是为了让 A 在没有密钥的情况下也能独立开发前端（说明书 8.2），
  // 且降级结果会通过启动日志与 GET /api/health 如实报告，不是"静默"降级。
  const fallbackChannel: ModelChannel = codebuddyApiKey.length > 0 ? 'sdk' : 'mock';
  const channel: ModelChannel =
    modelProvider === 'auto' ? fallbackChannel : modelProvider;

  return {
    port: readNumber(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',

    codebuddyApiKey,
    codebuddyEnvironment: readEnvironment(process.env.CODEBUDDY_INTERNET_ENVIRONMENT),

    deepseekApiKey,
    deepseekBaseUrl: readText(process.env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com'),
    deepseekModel: readText(process.env.DEEPSEEK_MODEL, 'deepseek-flash'),

    modelProvider,
    // 默认 60 秒，对应说明书 5.3
    modelTimeoutMs: readNumber(process.env.MODEL_TIMEOUT_MS, 60_000),
    channel,
  };
}

export const env = readEnv();

/**
 * 启动日志用。目的是让"本次运行到底用的是哪条通道"一目了然，
 * 避免演示或截图时误把 mock 或第三方通道当成平台能力（说明书 9.2 诚实性要求）。
 */
export function describeModelAdapter(): string {
  switch (env.channel) {
    case 'sdk':
      return `model=codebuddy-agent-sdk env=${env.codebuddyEnvironment}`;
    case 'deepseek':
      return (
        '⚠️ model=deepseek（第三方通道）—— 赛事方要求最终效果呈现不包含第三方 AI，' +
        '请勿在演示或评委体验时启用'
      );
    default:
      return env.modelProvider === 'mock'
        ? 'model=mock（已按 MODEL_PROVIDER=mock 强制，不调用真实模型）'
        : 'model=mock（未检测到 CODEBUDDY_API_KEY，已降级，不调用真实模型）';
  }
}

/** 启动时的补充警告；无问题时返回空数组 */
export function modelAdapterWarnings(): string[] {
  const warnings: string[] = [];
  if (env.channel === 'deepseek' && !env.deepseekApiKey) {
    warnings.push('已选择备选通道但未配置 DEEPSEEK_API_KEY，调用会直接失败。');
  }
  if (env.channel === 'sdk' && !env.codebuddyApiKey) {
    warnings.push('已强制主通道但未配置 CODEBUDDY_API_KEY，调用会直接失败（未静默降级）。');
  }
  return warnings;
}
