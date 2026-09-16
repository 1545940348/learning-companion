/**
 * 环境变量读取与校验。
 *
 * 密钥只存在于服务端，绝不进入前端或仓库（说明书 5.1）。
 * 本地开发从 apps/server/.env 读取（cwd 为 apps/server）；
 * 线上部署直接用环境变量注入，不依赖 .env 文件。
 *
 * 模型接入方式：CodeBuddy Agent SDK
 * （见 docs/tech/2026-09-16-模型接入-CodeBuddy Agent SDK.md）。
 * 认证由 SDK 读取环境变量完成，**没有 base URL，也没有固定模型名** ——
 * 模型由上游动态分配（同日实测 hy3 / glm-5.3 / minimax-m3 三个不同结果，只能从响应回读），
 * 因此本文件不再有 MODEL_BASE_URL 与 MODEL_NAME：
 * 这两个值在本接入方式下不存在，留着只会让后来的人去填一个填不出来的地址。
 */

import { config } from 'dotenv';

config();

/** 上游环境，与 SDK 的 AuthEnvironment 取值保持一致 */
export type CodebuddyEnvironment = 'external' | 'internal' | 'ioa' | 'cloudhosted';

/**
 * 适配器选择。
 * - `auto`（默认）：有密钥走真实 SDK，无密钥降级为 mock
 * - `mock`：强制 mock，不调用真实模型
 * - `sdk`：强制真实 SDK；无密钥时**不静默降级**，避免误把 mock 当成真实能力
 */
export type ModelProvider = 'auto' | 'mock' | 'sdk';

export interface Env {
  port: number;
  nodeEnv: string;
  /** 参赛账号密钥；仅服务端持有，绝不下发前端 */
  codebuddyApiKey: string;
  codebuddyEnvironment: CodebuddyEnvironment;
  modelProvider: ModelProvider;
  modelTimeoutMs: number;
  /** 实际生效的适配器：true 表示走 mock，false 表示走真实 SDK */
  useMock: boolean;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProvider(raw: string | undefined): ModelProvider {
  return raw === 'mock' || raw === 'sdk' || raw === 'auto' ? raw : 'auto';
}

const ENVIRONMENTS: readonly string[] = ['external', 'internal', 'ioa', 'cloudhosted'];

function readEnvironment(raw: string | undefined): CodebuddyEnvironment {
  const value = (raw ?? '').trim();
  return ENVIRONMENTS.includes(value) ? (value as CodebuddyEnvironment) : 'internal';
}

function readEnv(): Env {
  const codebuddyApiKey = (process.env.CODEBUDDY_API_KEY ?? '').trim();
  const modelProvider = readProvider(process.env.MODEL_PROVIDER);
  const useMock =
    modelProvider === 'mock' || (modelProvider === 'auto' && codebuddyApiKey.length === 0);

  return {
    port: readNumber(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    codebuddyApiKey,
    codebuddyEnvironment: readEnvironment(process.env.CODEBUDDY_INTERNET_ENVIRONMENT),
    modelProvider,
    // 默认 60 秒，对应说明书 5.3
    modelTimeoutMs: readNumber(process.env.MODEL_TIMEOUT_MS, 60_000),
    useMock,
  };
}

export const env = readEnv();

/**
 * 启动日志用。目的是让"这次运行到底用的是 mock 还是真实模型"一目了然，
 * 避免演示或截图时误把 mock 当成真实能力（说明书 9.2 诚实性要求）。
 */
export function describeModelAdapter(): string {
  if (!env.useMock) {
    return `model=codebuddy-agent-sdk env=${env.codebuddyEnvironment}`;
  }
  return env.modelProvider === 'mock'
    ? 'model=mock（已按 MODEL_PROVIDER=mock 强制，不调用真实模型）'
    : 'model=mock（未检测到 CODEBUDDY_API_KEY，已降级，不调用真实模型）';
}
