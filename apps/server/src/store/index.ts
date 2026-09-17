/**
 * 会话存储（内存实现）
 *
 * 初赛不引入数据库：会话仅在服务进程存活期间有效。
 * 前端另用 localStorage 保存当前标签页的材料文本与进度（说明书 5.4）。
 *
 * ### 2026-09-17 图谱落盘（V2.0 §3.3）
 *
 * 此前 `/api/knowledge` 只把 `points`/`prerequisites` 返回给前端就丢弃，
 * 存储里从未留下图谱 —— 于是 `GET /api/graph` 无数据可读、缺口状态也无法流转。
 * 现在图谱与材料在**同一次 CAS 提交**中写入，并共用同一个 `materialVersion`。
 */

import { randomUUID } from 'node:crypto';
import type {
  GraphEdge,
  GraphNeighborhood,
  LearnerProfile,
  Material,
  ProfileEvent,
  Session,
  SessionGraph,
  VerificationStatus,
  PrerequisiteStatus,
} from '@lc/contracts';
import { DEFAULT_VERIFICATION, MATERIAL_LIMITS } from '@lc/contracts';

const sessions = new Map<string, Session>();
const profiles = new Map<string, LearnerProfile>();

/** 空图谱。每次新建，避免多个会话共享同一个可变对象 */
function emptyGraph(): SessionGraph {
  return { nodes: [], edges: [] };
}

/** 新建会话。轻路径（零材料）会话的 materialVersion 为 0（§5.3） */
export function createSession(): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    materialVersion: 0,
    materials: [],
    supplements: [],
    graph: emptyGraph(),
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
  profiles.clear();
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

/**
 * 素材上限校验，超限时由路由返回可读提示（说明书 2.2、用例 E9）。
 *
 * 提示必须同时给出「已有份数」「本次份数」「合计」，否则学生看到
 * "最多 5 份材料，当前已有 0 份" 会以为是误报。
 */
export function checkMaterialQuota(session: Session, incoming: Material[]): string | null {
  const total = session.materials.length + incoming.length;
  if (total > MATERIAL_LIMITS.maxMaterialsPerSession) {
    return (
      `每个学习会话最多 ${MATERIAL_LIMITS.maxMaterialsPerSession} 份材料：` +
      `当前已有 ${session.materials.length} 份，本次提交 ${incoming.length} 份，合计 ${total} 份。` +
      '请减少本次份数或开始新学习。'
    );
  }
  const length = [...session.materials, ...incoming].reduce(
    (sum, material) => sum + material.text.length,
    0,
  );
  if (length > MATERIAL_LIMITS.maxTextLength) {
    return (
      `材料文本合计不能超过 ${MATERIAL_LIMITS.maxTextLength} 字：` +
      `当前已有 ${session.materials.reduce((sum, material) => sum + material.text.length, 0)} 字，` +
      `本次提交 ${incoming.reduce((sum, material) => sum + material.text.length, 0)} 字，合计 ${length} 字。` +
      '请缩短内容或开始新学习。'
    );
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

/* ==================== 原子提交（说明书 §3.3、C3 验收） ==================== */

/**
 * 版本冲突：提交时发现会话已被其他请求更新。
 *
 * 与 `SessionNotFoundError` 分开，因为语义不同 —— 这是**并发冲突**，不是找不到。
 * 由 `errorHandler` 映射为 409 + `SESSION_STALE`，
 * 提示前端丢弃本次结果、基于最新状态重试（§5.4）。
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
 * 用途：先把候选材料交给模型分析，成功后再提交（§3.3）。
 * 这样模型失败时，存储里的材料与版本都不会被改动。
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
 * 提交材料**并同批提交图谱**（V2.0 §3.3 步骤 5「整体提交新版本」）。
 *
 * 关键点：
 * - 图谱与材料共用同一个 `materialVersion`，二者要么一起生效、要么一起不生效；
 * - `materials` 为空时只做版本复核，不递增版本（保持既有语义）；
 * - 图谱为空时**不清空**已有图谱 —— 模型本次没抽到关系，不构成"删掉旧图谱"的理由。
 */
export function commitMaterials(
  sessionId: string,
  materials: Material[],
  expectedVersion: number,
  graph?: SessionGraph,
): Session {
  const session = requireSession(sessionId);
  assertVersionUnchanged(session, expectedVersion);

  const hasGraph = graph !== undefined && (graph.nodes.length > 0 || graph.edges.length > 0);
  if (materials.length === 0 && !hasGraph) return session;

  const next: Session = {
    ...session,
    materials: materials.length > 0 ? [...session.materials, ...materials] : session.materials,
    graph: hasGraph ? graph : session.graph,
    materialVersion: session.materialVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, next);
  return next;
}

/**
 * 把一次补充写入图谱：被补齐概念的入边转为 `SUPPLEMENTED`（或验证通过后的 `VERIFIED`），
 * 并把补充块作为证据挂上（§3.4「补充缺口后重新检查当前关系，保留稳定编号」）。
 *
 * 只改 `to === conceptId` 的边（即"被依赖的前置"），不动概念节点本身，
 * 也**不新建节点** —— 概念节点应由图谱构建阶段产生，不在这里凭空补。
 */
function applySupplementToGraph(
  graph: SessionGraph,
  supplement: SupplementBlockLike,
  status: PrerequisiteStatus,
  verification: VerificationStatus,
): SessionGraph {
  // 摘录取补充内容开头，长度与校验层的定位要求一致即可（过长会拖大响应体）
  const excerpt = supplement.content.slice(0, 40);
  let touched = false;

  const edges: GraphEdge[] = graph.edges.map((edge) => {
    if (edge.to !== supplement.conceptId) return edge;
    touched = true;
    return {
      ...edge,
      status,
      verification,
      // 依据改指向补充块：来源可定位到补充内容（§3.4）
      evidence: [
        ...edge.evidence,
        { sourceType: 'ai-supplement' as const, refId: supplement.id, excerpt },
      ],
    };
  });

  if (!touched) return graph;
  return { ...graph, edges };
}

/**
 * 提交 AI 补充块：与 `commitMaterials` 同样带版本前置条件（§5.4）。
 *
 * `/gap` 原先只在请求入口校验过一次版本，模型调用期间若有并发请求提交过，
 * 这里会覆盖新状态。现改为提交前复核。
 */
export function commitSupplement(
  sessionId: string,
  supplement: SupplementBlockLike,
  expectedVersion: number,
  status: PrerequisiteStatus = 'SUPPLEMENTED',
): Session {
  const session = requireSession(sessionId);
  assertVersionUnchanged(session, expectedVersion);

  const verification: VerificationStatus = supplement.verification ?? DEFAULT_VERIFICATION;
  const next: Session = {
    ...session,
    supplements: [...session.supplements, supplement as Session['supplements'][number]],
    graph: applySupplementToGraph(session.graph, supplement, status, verification),
    materialVersion: session.materialVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, next);
  return next;
}

/** `commitSupplement` 的最小入参形状（避免把 contracts 的具体类型硬绑进来） */
type SupplementBlockLike = {
  id: string;
  sessionId: string;
  conceptId: string;
  content: string;
  authorizedAt: string;
  verification?: VerificationStatus;
};

/* ==================== 图谱读取（GET /api/graph） ==================== */

/**
 * 取图谱邻域。
 *
 * `rootConceptId` 为空时返回全量；非空时做**一层邻域**展开：中心节点 + 与之直接
 * 相连的节点与边。说明书 §2.3 的图谱视图只要求看到前置／后继／并列／例证关系，
 * 不做多跳，因此这里刻意不做递归。
 */
export function getGraphNeighborhood(
  session: Session,
  rootConceptId: string | null,
): GraphNeighborhood {
  const { nodes, edges } = session.graph;

  if (rootConceptId === null) {
    return {
      sessionId: session.id,
      materialVersion: session.materialVersion,
      rootConceptId: null,
      nodes,
      edges,
    };
  }

  const incident = edges.filter((edge) => edge.from === rootConceptId || edge.to === rootConceptId);
  const keep = new Set<string>([rootConceptId]);
  for (const edge of incident) {
    keep.add(edge.from);
    keep.add(edge.to);
  }

  return {
    sessionId: session.id,
    materialVersion: session.materialVersion,
    rootConceptId,
    nodes: nodes.filter((node) => keep.has(node.id)),
    edges: incident,
  };
}

/* ==================== 学习画像（POST /api/profile） ==================== */

/**
 * 追加画像事件并返回更新后的画像。
 *
 * 只做**会话内聚合**（V2.0 阶段二要求「画像基础版」）：
 * 从事件流推导 mastery / gaps / misconceptions。
 * 补充内容不跨会话迁移，画像事件按规则保留（用例 E16）——
 * 因此事件本身可直接重放到新会话，但 `mastery` 只反映本会话。
 */
export function commitProfileEvents(
  session: Session,
  events: ProfileEvent[],
): LearnerProfile {
  const previous = profiles.get(session.id);
  const profile: LearnerProfile = previous
    ? {
        ...previous,
        mastery: { ...previous.mastery },
        gaps: [...previous.gaps],
        misconceptions: [...previous.misconceptions],
      }
    : {
        sessionId: session.id,
        mastery: {},
        gaps: [],
        misconceptions: [],
        updatedAt: new Date().toISOString(),
      };

  for (const event of events) {
    switch (event.type) {
      case 'gap-supplemented': {
        if (!event.conceptId) break;
        profile.mastery[event.conceptId] = 'SUPPLEMENTED';
        const existing = profile.gaps.find((gap) => gap.conceptId === event.conceptId);
        if (existing) {
          existing.resolvedAt = event.at;
        } else {
          profile.gaps.push({ conceptId: event.conceptId, resolvedAt: event.at });
        }
        break;
      }
      case 'gap-claimed-known': {
        // 「我已掌握」只影响引导，**不改变材料覆盖状态**（§2.3）：
        // 这里刻意不写 mastery，避免把学生的自我评估当成材料证据。
        break;
      }
      case 'quiz-attribution': {
        const kind = event.payload?.kind;
        const pattern = event.payload?.pattern;
        if (typeof kind !== 'string' || typeof pattern !== 'string') break;
        const found = profile.misconceptions.find(
          (item) => item.kind === kind && item.pattern === pattern,
        );
        if (found) {
          found.count += 1;
        } else {
          profile.misconceptions.push({
            kind: kind as LearnerProfile['misconceptions'][number]['kind'],
            pattern,
            count: 1,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  profile.updatedAt = new Date().toISOString();
  profiles.set(session.id, profile);
  return profile;
}

export function getProfile(sessionId: string): LearnerProfile | undefined {
  return profiles.get(sessionId);
}
