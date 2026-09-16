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
