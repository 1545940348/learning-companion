/**
 * 接口客户端 —— A 负责扩展
 *
 * 前端只与同源的 /api 通信；密钥与模型调用全部留在服务端。
 * 约定：服务端返回统一错误结构 { error: { code, message, retryable } }（说明书 5.2）。
 */

import type {
  ApiErrorBody,
  GraphResponse,
  HealthResponse,
  KnowledgeRequest,
  KnowledgeResponse,
  ParseRequest,
  ParseResponse,
  ProfileRequest,
  ProfileResponse,
  QuizRequest,
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

  /**
   * ⚠️ V2.0 起由 GET 改为 POST（`QuizRequest` 随 body 提交）。
   * 与 `packages/contracts` 的 `QuizRequest` 保持一致，不再拼 query。
   */
  quiz: (payload: QuizRequest) =>
    request<QuizResponse>('/quiz', { method: 'POST', body: JSON.stringify(payload) }),

  /** 图谱邻域；不传 knowledgePointId 时返回会话图谱全量 */
  graph: (sessionId: string, knowledgePointId?: string) => {
    const params = new URLSearchParams({ sessionId });
    if (knowledgePointId) {
      params.set('knowledgePointId', knowledgePointId);
    }
    return request<GraphResponse>(`/graph?${params.toString()}`);
  },

  profile: (payload: ProfileRequest) =>
    request<ProfileResponse>('/profile', { method: 'POST', body: JSON.stringify(payload) }),
};
