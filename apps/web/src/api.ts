/**
 * 接口客户端 —— A 负责扩展
 *
 * 前端只与同源的 /api 通信；密钥与模型调用全部留在服务端。
 * 约定：服务端返回统一错误结构 { error: { code, message, retryable } }（说明书 5.2）。
 */

import type {
  ApiErrorBody,
  HealthResponse,
  KnowledgeRequest,
  KnowledgeResponse,
  ParseRequest,
  ParseResponse,
  QuizResponse,
  Session,
  TutorRequest,
  TutorResponse,
} from '@lc/contracts';

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      body?.error.message ?? `请求失败（HTTP ${response.status}）`,
      body?.error.code ?? 'UNKNOWN',
      body?.error.retryable ?? false,
    );
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  createSession: () => request<Session>('/session', { method: 'POST' }),

  parse: (payload: ParseRequest) =>
    request<ParseResponse>('/parse', { method: 'POST', body: JSON.stringify(payload) }),

  knowledge: (payload: KnowledgeRequest) =>
    request<KnowledgeResponse>('/knowledge', { method: 'POST', body: JSON.stringify(payload) }),

  ask: (payload: TutorRequest) =>
    request<TutorResponse>('/tutor', { method: 'POST', body: JSON.stringify(payload) }),

  quiz: (topic: string, source: 'fixed' | 'material', sessionId?: string) => {
    const params = new URLSearchParams({ topic, source });
    if (sessionId) {
      params.set('sessionId', sessionId);
    }
    return request<QuizResponse>(`/quiz?${params.toString()}`);
  },
};
