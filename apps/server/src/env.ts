/**
 * 环境变量读取与校验。
 *
 * 密钥只存在于服务端，绝不进入前端或仓库（说明书 5.1）。
 * 本地开发从 apps/server/.env 读取（cwd 为 apps/server）；
 * 线上部署直接用环境变量注入，不依赖 .env 文件。
 */

import { config } from 'dotenv';

config();

export interface Env {
  port: number;
  nodeEnv: string;
  modelProvider: string;
  modelApiKey: string;
  modelBaseUrl: string;
  modelName: string;
  modelTimeoutMs: number;
  /**
   * 未配置密钥时自动降级为 mock 适配器。
   * 这样 A 可以在没有真实密钥的情况下独立开发前端（说明书 8.2）。
   */
  useMock: boolean;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnv(): Env {
  const modelProvider = process.env.MODEL_PROVIDER ?? 'mock';
  const modelApiKey = process.env.MODEL_API_KEY ?? '';
  const useMock = modelProvider === 'mock' || modelApiKey.length === 0;

  return {
    port: readNumber(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    modelProvider: useMock ? 'mock' : modelProvider,
    modelApiKey,
    modelBaseUrl: process.env.MODEL_BASE_URL ?? '',
    modelName: process.env.MODEL_NAME ?? '',
    // 默认 60 秒，对应说明书 5.3
    modelTimeoutMs: readNumber(process.env.MODEL_TIMEOUT_MS, 60_000),
    useMock,
  };
}

export const env = readEnv();
