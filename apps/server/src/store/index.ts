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
  ClassAggregate,
  MisconceptionKind,
  Session,
  SessionGraph,
  SessionSummary,
  VerificationStatus,
  PrerequisiteStatus,
} from '@lc/contracts';
import { DEFAULT_VERIFICATION, MATERIAL_LIMITS, VERIFYING_STATUSES } from '@lc/contracts';

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

/**
 * 列出全部会话的**摘要**，按 `updatedAt` 倒序（2026-09-23 新增，供 `GET /api/sessions`）。
 *
 * ### 关于"这个函数被删过又加回来"（`I19`）
 *
 * 2026-09-18 的全量复查把 `listSessions` 当作**死代码**删掉了 —— 当时它确实**没有任何调用点**。
 * 现在它回来了，但**不是回潮**：它有了真实消费方（`routes.ts` 的 `GET /api/sessions`）
 * 与真实断言（`verify:graph` 的摘要节 + `verify:flow` 的 HTTP 节）。
 * 判据始终是"**有没有消费方**"，不是"看起来有没有用" —— 所以这次加得。
 *
 * ⚠️ 只回**元信息**：材料正文、图谱与补充块正文一律不进列表（见 `SessionSummary` 的注释）。
 * ⚠️ 排序带 `id` 作为**平手时的次级键**：同一毫秒创建的两个会话否则顺序不定，
 * 断言会偶发失败（"看起来像 flaky，其实是排序不确定"）。
 */
export function listSessionSummaries(): SessionSummary[] {
  return [...sessions.values()]
    .map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      materialVersion: session.materialVersion,
      materialCount: session.materials.length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/* ==================== 班级聚合（P-C11，阶段三） ==================== */

/** 六态计数器（全 0）；`aggregateClass` 用它初始化每个概念的分布 */
function emptyStatusCount(): Record<PrerequisiteStatus, number> {
  return { LOCAL: 0, SUPPLEMENTED: 0, MISSING: 0, PENDING: 0, VERIFIED: 0, DISPUTED: 0 };
}

/**
 * 班级聚合：把当前进程内的会话汇总成**只含计数与概念维度**的班级视图（`P-C11`）。
 *
 * ### 演示级的"班级"到底是什么（这条必须说清）
 *
 * 契约里 `TeacherQuery { classId }` 一直存在，但**服务端从来没有班级实体** ——
 * 会话只按 `sessionId` 存，没有"这个学生属于哪个班"的概念。
 * 本实现**不假装有班级**：把**当前进程内所有会话视为一个班**，`classId` 原样回显
 * （不校验、不编造、不写入），并把这一点写进接口文档。
 *
 * 之所以这样做而不是"先造个班级实体"：演示要的是**真实数据的聚合**，
 * 不是**编出来的组织关系**。样本量由 `studentCount` 如实报出，
 * 低于 `TEACHER_MIN_SAMPLE`（5）时由消费方提示「样本不足」（§11 边界）。
 *
 * ### 为什么只输出这三样
 *
 * 契约对 `ClassAggregate` 的定义是「**只含计数与概念维度统计**，不含个人信息（用例 E17）」。
 * 所以这里只给：**状态分布 / 误区排行 / 覆盖热度** ——
 * 十进制的计数不会反推到任何具体学生，`studentCount` 也只是一个总数。
 */
export function aggregateClass(classId: string): ClassAggregate {
  const mastery: Record<string, Record<PrerequisiteStatus, number>> = {};
  const misconceptionMap = new Map<
    string,
    { kind: MisconceptionKind; pattern: string; count: number }
  >();
  const coverageHeat: { materialId: string; conceptId: string; covered: boolean }[] = [];

  for (const session of sessions.values()) {
    const profile = profiles.get(session.id);
    if (profile) {
      /* ① 掌握状态分布：概念 → 状态 → 人数 */
      for (const [conceptId, status] of Object.entries(profile.mastery)) {
        mastery[conceptId] = mastery[conceptId] ?? emptyStatusCount();
        mastery[conceptId][status] += 1;
      }

      /* ② 误区排行：按 `kind + pattern` 合并计数 —— 只合并**字面相同**的，不做语义归并 */
      for (const item of profile.misconceptions) {
        const key = `${item.kind}|${item.pattern}`;
        const existing = misconceptionMap.get(key);
        if (existing) existing.count += item.count;
        else misconceptionMap.set(key, { kind: item.kind, pattern: item.pattern, count: item.count });
      }
    }

    /* ③ 覆盖热度：每份材料 × 每个图谱节点，是否判为「材料已覆盖」 */
    for (const material of session.materials) {
      for (const node of session.graph.nodes) {
        coverageHeat.push({
          materialId: material.id,
          conceptId: node.id,
          /*
           * 判据与图谱同源：`KnowledgePoint` **没有 `status` 字段**（六态属于**前置关系**），
           * 所以「材料是否覆盖」只能按图谱自己的口径判 —— 与 `GraphPanel.nodeStatus` 的
           * "第 3 条来源"一致：**有 `citations` ⇒ 能定位来源 ⇒ 已覆盖**。
           * 没有引用时**不算覆盖**，免得把"模型没给引用"说成"材料覆盖了"。
           */
          covered: node.citations.length > 0,
        });
      }
    }
  }

  return {
    classId,
    /* 样本量 = 有画像的会话数（画像按 sessionId 存，这也是"一个学生"的粒度） */
    studentCount: profiles.size,
    mastery,
    misconceptions: [...misconceptionMap.values()].sort(
      (a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern),
    ),
    coverageHeat,
    updatedAt: new Date().toISOString(),
  };
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

  /*
   * `I18` 一致性断言（§3.4 的硬规则，此前只写在文档与类型注释里、**没有机械检查**）：
   * 「`SUPPLEMENTED → VERIFIED` 仅当验证状态为 `symbolic` 或 `human`」。
   *
   * 调用方若传 `status = 'VERIFIED'` 而验证状态不达标 → **直接拒绝**，不静默降级：
   * 一个手滑的调用点就能把未验证内容写成「已验证」，而"不把未验证内容说成已验证"
   * 是本项目的真实性底座（§4.2）。宁可抛错暴露，也不要悄悄写进去。
   *
   * ⚠️ **未对 `DISPUTED` 加同类断言**：§3.2 对 DISPUTED 的定义是
   * 「验证失败**或来源冲突**」—— 来源冲突未必伴随 `failed`，
   * 断言写成"只有 failed 才能 DISPUTED"会挡住合法路径。
   * 只把**规则原文明确**的那一条焊死。
   */
  if (status === 'VERIFIED' && !VERIFYING_STATUSES.includes(verification)) {
    throw new Error(
      `commitSupplement: 验证状态 "${verification}" 不足以把前置关系标为 VERIFIED（需 ${VERIFYING_STATUSES.join(' 或 ')}）`,
    );
  }

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
