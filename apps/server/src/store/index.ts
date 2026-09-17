/**
 * 会话存储（内存实现）
 *
 * 初赛不引入数据库：会话仅在服务进程存活期间有效。
 * 前端另用 localStorage 保存当前标签页的材料文本与进度（说明书 5.3）。
 */

import { randomUUID } from 'node:crypto';
import type { Material, Session, SupplementBlock } from '@lc/contracts';
import { MATERIAL_LIMITS } from '@lc/contracts';

const sessions = new Map<string, Session>();

/** 新建会话。轻路径（零材料）会话的 materialVersion 为 0 */
export function createSession(): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    materialVersion: 0,
    materials: [],
    supplements: [],
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

/** 供测试与手动排查使用 */
export function listSessions(): Session[] {
  return [...sessions.values()];
}

export function clearSessions(): void {
  sessions.clear();
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`会话不存在：${id}`);
    this.name = 'SessionNotFoundError';
  }
}

export function requireSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    throw new SessionNotFoundError(id);
  }
  return session;
}

/** 素材上限校验，超限时由路由返回可读提示（说明书 2.2、用例 E9） */
export function checkMaterialQuota(session: Session, incoming: Material[]): string | null {
  const total = session.materials.length + incoming.length;
  if (total > MATERIAL_LIMITS.maxMaterialsPerSession) {
    return `每个学习会话最多 ${MATERIAL_LIMITS.maxMaterialsPerSession} 份材料，当前已有 ${session.materials.length} 份。请缩短内容或开始新学习。`;
  }
  const length = [...session.materials, ...incoming].reduce(
    (sum, material) => sum + material.text.length,
    0,
  );
  if (length > MATERIAL_LIMITS.maxTextLength) {
    return `材料文本合计不能超过 ${MATERIAL_LIMITS.maxTextLength} 字，当前为 ${length} 字。请缩短内容或开始新学习。`;
  }
  return null;
}

/** 写入材料并递增版本。失败时不改动已有状态 */
export function applyMaterials(sessionId: string, materials: Material[]): Session {
  const session = requireSession(sessionId);
  const next: Session = {
    ...session,
    materials: [...session.materials, ...materials],
    materialVersion: session.materialVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, next);
  return next;
}

/** 写入 AI 补充块并递增版本；补充块绑定会话，不跨会话引用（说明书 4.2） */
export function applySupplement(sessionId: string, supplement: SupplementBlock): Session {
  const session = requireSession(sessionId);
  const next: Session = {
    ...session,
    supplements: [...session.supplements, supplement],
    materialVersion: session.materialVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, next);
  return next;
}

/* ==================== 原子提交（说明书 9.3、C3 验收） ==================== */

/**
 * 版本冲突：提交时发现会话已被其他请求更新。
 *
 * 与 `SessionNotFoundError` 分开，因为语义不同 —— 这是**并发冲突**，不是找不到。
 * 由 http/middleware.ts 映射为 HTTP 409 + `SESSION_STALE`，
 * 提示前端丢弃本次结果、基于最新状态重试（说明书 5.3）。
 */
export class SessionVersionConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `材料版本已更新（本次分析基于版本 ${expectedVersion}，当前已是 ${actualVersion}），` +
        '本次结果已过期，请基于最新状态重试',
    );
    this.name = 'SessionVersionConflictError';
  }
}

/**
 * 构造「写入这些材料后会得到的会话」—— **纯函数，不写入存储**。
 *
 * 用途：先把候选材料交给模型分析，成功后再提交（说明书 9.3）。
 * 这样模型失败时，存储里的材料与版本都不会被改动。
 *
 * 数据结构形状：
 * - `session.materials`：该会话既有材料，`Material` 形如 `{ id, kind, text }`；
 * - `incoming`：本次新增材料，与既有材料**顺序拼接**（既有在前）；
 * - 返回值的 `materialVersion` 为 `session.materialVersion + 1`，
 *   与随后 `commitMaterials` 的结果一致，因此可把候选直接交给教学模块分析；
 * - `incoming` 为空时原样返回，不递增版本（与既有行为一致）。
 */
export function previewMaterials(session: Session, incoming: Material[]): Session {
  if (incoming.length === 0) return session;
  return {
    ...session,
    materials: [...session.materials, ...incoming],
    materialVersion: session.materialVersion + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 版本前置条件检查（compare-and-swap 的前半段）。
 *
 * ⚠️ 调用方必须保证：**本检查与随后的写入之间不得出现 `await`**。
 * 本模块是同步的内存实现，因此只要两句连着写，检查即有效。
 * 若将来改为异步存储或数据库，必须换成事务或真正的 CAS 写。
 */
function assertVersionUnchanged(session: Session, expectedVersion: number): void {
  if (session.materialVersion !== expectedVersion) {
    throw new SessionVersionConflictError(session.id, expectedVersion, session.materialVersion);
  }
}

/**
 * 提交材料：仅当会话版本仍等于 `expectedVersion` 时才写入。
 *
 * 这是「响应提交前复核版本」的落点 —— 防止并发旧响应覆盖新状态（说明书 9.3）。
 * `materials` 为空时只做版本复核，不递增版本。
 */
export function commitMaterials(
  sessionId: string,
  materials: Material[],
  expectedVersion: number,
): Session {
  const session = requireSession(sessionId);
  assertVersionUnchanged(session, expectedVersion);
  if (materials.length === 0) return session;
  return applyMaterials(sessionId, materials);
}

/**
 * 提交 AI 补充块：与 `commitMaterials` 同样带版本前置条件。
 *
 * `/gap` 原先只在请求入口校验过一次版本，模型调用期间（约 1—3 秒）若有并发请求
 * 提交过，这里会覆盖新状态。现改为提交前复核。
 */
export function commitSupplement(
  sessionId: string,
  supplement: SupplementBlock,
  expectedVersion: number,
): Session {
  const session = requireSession(sessionId);
  assertVersionUnchanged(session, expectedVersion);
  return applySupplement(sessionId, supplement);
}
