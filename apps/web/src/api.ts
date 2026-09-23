/**
 * 接口客户端 —— A 负责扩展
 *
 * 前端只与同源的 /api 通信；密钥与模型调用全部留在服务端。
 * 约定：服务端返回统一错误结构 { error: { code, message, retryable } }（说明书 5.2）。
 */

import type {
  ApiErrorBody,
  GapRequest,
  GapResponse,
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
  TeacherResponse,
  TutorRequest,
  TutorResponse,
} from '@lc/contracts';

const BASE = '/api';

/**
 * 客户端请求超时（拆分阶段 0 · 卡 3 / 缺陷 `D-03`；`D5` 拍板值）
 *
 * ### 为什么是 120 s
 *
 * 服务端 `MODEL_TIMEOUT_MS = 90_000` 是**单次模型调用**的上限，而一次用户动作
 * （如"提交讲义"）可能包含多次调用。客户端超时**必须大于**服务端，否则会出现
 * "学生看到失败、服务端仍在烧额度"——两边的结论对不上，且失败信息是假的。
 * 120 s = 90 s + 余量。
 *
 * ⚠️ 别把这两个数字当成"随手可调的参数"：改任一处都要同时看另一处，
 * 并同步 `docs/知识库.md` §7（那里是常量的唯一汇总）。
 */
export const CLIENT_TIMEOUT_MS = 120_000;

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

/** 中止的两种成因。**必须区分**：超时是失败（可重试），用户取消不是失败 */
export type AbortKind = 'timeout' | 'cancelled';

export class RequestAbortedError extends Error {
  constructor(readonly kind: AbortKind) {
    super(kind === 'timeout' ? '请求超时' : '请求已取消');
    this.name = 'RequestAbortedError';
  }
}

/**
 * 中止该怎么说给学生听（纯函数，便于断言 —— `verify:render` 有真值表用例）。
 *
 * 为什么不能混成一句话：「超时」意味着这次没成功、可以重试；
 * 「取消」是学生自己按的，**不该报错、也不该给重试按钮** ——
 * 把它渲染成错误提示等于在说"你的操作失败了"，那是无据的（§9）。
 */
export function describeAbort(kind: AbortKind): { retryable: boolean; text: string } {
  if (kind === 'timeout') {
    return {
      retryable: true,
      text: `这次请求超过 ${CLIENT_TIMEOUT_MS / 1000} 秒仍未返回，已中止。服务端可能仍在处理，可以直接重试。`,
    };
  }
  return {
    retryable: false,
    text: '这次请求已取消，未完成的步骤不会再改变页面状态（已经完成的部分保留）。',
  };
}

/**
 * 在飞请求的登记表 —— 只用于"学生点取消"时统一中止。
 *
 * 为什么放在模块级而不是 hook 里：`api` 的每个方法都是无状态函数，
 * 取消需要能触达**所有正在飞的**请求；放在 hook 里只能取消它自己发起的那些，
 * 而实际发起者分散在多个动作里。
 */
const inFlight = new Set<AbortController>();

/** 取消所有在飞请求。返回被取消的数量（便于断言与提示文案） */
export function cancelInFlightRequests(): number {
  const count = inFlight.size;
  for (const controller of inFlight) {
    controller.abort(new RequestAbortedError('cancelled'));
  }
  inFlight.clear();
  return count;
}

/** 当前在飞请求数（仅用于提示与验证） */
export function inFlightCount(): number {
  return inFlight.size;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  inFlight.add(controller);

  /*
   * 超时用一个**内部**控制器实现，并与调用方可能传入的 `signal` 组合：
   * 任一先触发都中止本次请求。
   */
  const timer = setTimeout(() => {
    controller.abort(new RequestAbortedError('timeout'));
  }, CLIENT_TIMEOUT_MS);

  const external = init?.signal;
  const forwardExternal = () => controller.abort(new RequestAbortedError('cancelled'));
  if (external) {
    if (external.aborted) forwardExternal();
    else external.addEventListener('abort', forwardExternal, { once: true });
  }

  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
      signal: controller.signal,
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
  } catch (error) {
    /*
     * `fetch` 被中止时抛的是 `AbortError`（DOMException），
     * 真正的原因在 `signal.reason` 里 —— 必须把它还原成 `RequestAbortedError`，
     * 否则上层只能看到"某个 AbortError"，分不清超时与取消。
     */
    if (error instanceof Error && error.name === 'AbortError') {
      const reason = controller.signal.reason;
      throw reason instanceof RequestAbortedError ? reason : new RequestAbortedError('cancelled');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardExternal);
    inFlight.delete(controller);
  }
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

  /** 缺口一键补充（§2.3）。学生点击「补上这一段」即视为授权（§4.2） */
  gap: (payload: GapRequest) =>
    request<GapResponse>('/gap', { method: 'POST', body: JSON.stringify(payload) }),

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

  /**
   * 教师视图：班级聚合（`P-A6` 接入，2026-09-23）。
   *
   * ⚠️ `classId` 在服务端是**回显值** —— 没有班级实体，当前进程内的会话视为一个班。
   * 这一点必须和界面文案一致（界面写「演示级：当前所有会话视为一个班」），
   * 否则就成了"假装有组织关系"。
   */
  teacher: (classId: string) =>
    request<TeacherResponse>(`/teacher?${new URLSearchParams({ classId }).toString()}`),
};
