/**
 * 教学任务 —— 由 B 负责实现与调优
 *
 * 三个任务函数只依赖注入的模型函数，因此脱离网页与托管平台即可测试（说明书 7.2）。
 */

import type {
  AnswerBlock,
  AnswerScope,
  Citation,
  GraphEdge,
  KnowledgePoint,
  NextStep,
  PrerequisiteRelation,
  PrerequisiteStatus,
  QuizItem,
  RecentAnswer,
  RelationKind,
  SessionGraph,
  Topic,
  TutorMode,
  VerificationStatus,
} from '@lc/contracts';
import { DEFAULT_VERIFICATION } from '@lc/contracts';
import type { ModelCaller } from './model.js';
import {
  SYSTEM_GAP,
  SYSTEM_KNOWLEDGE,
  SYSTEM_QUIZ_FROM_MATERIAL,
  SYSTEM_TUTOR,
} from './prompt.js';

/* ==================== 模型输出的归一（V2.0：验证状态 + 图谱） ==================== */

/**
 * 归一验证状态。
 *
 * 模型可能不返回该字段，或返回无法识别的取值。**一律落到 `unverified`**，
 * 不能落到 `symbolic` —— 说明书 §4.2 要求"必须经过符号验证**或标记为未验证**，
 * 不得默认视为正确"，缺省落在"已验证"一侧就是把未验证内容当成正确内容。
 */
function toVerification(raw: unknown): VerificationStatus {
  return raw === 'symbolic' || raw === 'human' || raw === 'unverified' || raw === 'failed'
    ? raw
    : DEFAULT_VERIFICATION;
}

const PREREQUISITE_STATUSES: readonly PrerequisiteStatus[] = [
  'LOCAL',
  'SUPPLEMENTED',
  'MISSING',
  'PENDING',
  'VERIFIED',
  'DISPUTED',
];

function toPrerequisiteStatus(raw: unknown): PrerequisiteStatus {
  return typeof raw === 'string' && PREREQUISITE_STATUSES.includes(raw as PrerequisiteStatus)
    ? (raw as PrerequisiteStatus)
    : 'PENDING';
}

const RELATION_KINDS: readonly RelationKind[] = [
  'prerequisite',
  'derives',
  'illustrates',
  'contrasts',
  'extends',
  'depends_on',
];

/** 边界判定取值（说明书 4.1）；用于校验模型输出，避免非法值透传到前端 */
const ANSWER_SCOPES: readonly AnswerScope[] = [
  'in-material',
  'derivable',
  'missing-prereq',
  'partial',
  'out-of-scope',
  'insufficient-question',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把模型返回的知识点补齐必需字段，尤其是验证状态 */
function normalizePoint(raw: unknown): KnowledgePoint | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id.length === 0) return null;

  const point: KnowledgePoint = {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    explanation: typeof raw.explanation === 'string' ? raw.explanation : '',
    citations: Array.isArray(raw.citations) ? (raw.citations as Citation[]) : [],
    verification: toVerification(raw.verification),
  };
  if (typeof raw.formula === 'string') point.formula = raw.formula;
  if (typeof raw.conditions === 'string') point.conditions = raw.conditions;
  if (Array.isArray(raw.misconceptions)) {
    point.misconceptions = raw.misconceptions.filter(
      (item): item is string => typeof item === 'string',
    );
  }
  return point;
}

/** 把模型返回的前置关系补齐必需字段 */
function normalizePrerequisite(raw: unknown): PrerequisiteRelation | null {
  if (!isPlainObject(raw)) return null;
  const conceptId = typeof raw.conceptId === 'string' ? raw.conceptId.trim() : '';
  if (conceptId.length === 0) return null;

  return {
    conceptId,
    conceptName: typeof raw.conceptName === 'string' ? raw.conceptName : conceptId,
    status: toPrerequisiteStatus(raw.status),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    evidence: Array.isArray(raw.evidence) ? (raw.evidence as Citation[]) : [],
    verification: toVerification(raw.verification),
  };
}

/**
 * 归一一条关系边。
 *
 * 排除**自依赖**（`from === to`）—— 说明书 §3.3 归一阶段要求排除自依赖与循环依赖，
 * 未通过的关系不得进入图谱（用例 E15）。
 */
function normalizeEdge(raw: unknown): GraphEdge | null {
  if (!isPlainObject(raw)) return null;
  const from = typeof raw.from === 'string' ? raw.from.trim() : '';
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  if (from.length === 0 || to.length === 0 || from === to) return null;

  const edge: GraphEdge = {
    from,
    to,
    kind:
      typeof raw.kind === 'string' && RELATION_KINDS.includes(raw.kind as RelationKind)
        ? (raw.kind as RelationKind)
        : 'prerequisite',
    status: toPrerequisiteStatus(raw.status),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    evidence: Array.isArray(raw.evidence) ? (raw.evidence as Citation[]) : [],
    verification: toVerification(raw.verification),
  };
  if (raw.inferred === true) edge.inferred = true;
  return edge;
}

/**
 * 排除循环依赖（用例 E15）。
 *
 * 按顺序保留边，若某条边会让图中出现环则丢弃它 —— 依赖图必须是有向无环的，
 * 否则后续"从哪个知识点出发找缺口"就没有确定答案。
 */
function dropCycles(edges: GraphEdge[]): GraphEdge[] {
  const kept: GraphEdge[] = [];
  const adjacency = new Map<string, Set<string>>();

  const reaches = (from: string, target: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of adjacency.get(node) ?? []) stack.push(next);
    }
    return false;
  };

  for (const edge of edges) {
    if (reaches(edge.to, edge.from)) continue;
    kept.push(edge);
    const outgoing = adjacency.get(edge.from) ?? new Set<string>();
    outgoing.add(edge.to);
    adjacency.set(edge.from, outgoing);
  }
  return kept;
}

/**
 * 组装图谱快照：节点取自知识点，边取自模型返回的显式关系。
 *
 * 模型未返回 `edges` 时**只有节点、没有边** —— 不凭 `prerequisites` 猜 `from`，
 * 因为"哪个知识点依赖它"是模型该说清的事，猜出来的关系会污染缺口判定。
 */
function buildGraph(rawGraph: unknown, points: KnowledgePoint[]): SessionGraph {
  const source = isPlainObject(rawGraph) ? rawGraph : {};
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  const edges: GraphEdge[] = [];
  for (const item of rawEdges) {
    const edge = normalizeEdge(item);
    if (edge) edges.push(edge);
  }
  return { nodes: points, edges: dropCycles(edges) };
}

/** 送入模型的材料片段。kind 用于让模型区分讲义与系统补充 */
export interface MaterialSlice {
  id: string;
  kind: 'upload' | 'ai-supplement';
  text: string;
}

function renderMaterials(materials: MaterialSlice[]): string {
  if (materials.length === 0) {
    return '（学生未提供任何材料）';
  }
  return materials
    .map((material) => {
      const label = material.kind === 'ai-supplement' ? '系统补充' : '学生材料';
      return `【${label} ${material.id}】\n${material.text}`;
    })
    .join('\n\n');
}

/** 从模型输出中取出 JSON，容忍 ```json 包裹与前后缀文本 */
function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const source = fenced?.[1] ?? raw;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('模型未返回可解析的 JSON');
  }
  return JSON.parse(source.slice(start, end + 1));
}

/* ============ 知识点与前置依赖抽取 ============ */

export interface AnalyzeKnowledgeInput {
  materials: MaterialSlice[];
}

export interface AnalyzeKnowledgeOutput {
  points: KnowledgePoint[];
  prerequisites: PrerequisiteRelation[];
  /** 图谱快照；由服务端与材料一并原子提交（§3.3 步骤 5） */
  graph: SessionGraph;
}

export async function analyzeKnowledge(
  call: ModelCaller,
  input: AnalyzeKnowledgeInput,
): Promise<AnalyzeKnowledgeOutput> {
  const raw = await call(renderMaterials(input.materials), {
    system: SYSTEM_KNOWLEDGE,
    json: true,
  });

  const parsed = extractJson(raw) as Record<string, unknown>;

  const points: KnowledgePoint[] = [];
  for (const item of Array.isArray(parsed.points) ? parsed.points : []) {
    const point = normalizePoint(item);
    if (point) points.push(point);
  }

  const prerequisites: PrerequisiteRelation[] = [];
  for (const item of Array.isArray(parsed.prerequisites) ? parsed.prerequisites : []) {
    const relation = normalizePrerequisite(item);
    if (relation) prerequisites.push(relation);
  }

  return {
    points,
    prerequisites,
    graph: buildGraph(parsed.graph, points),
  };
}

/* ============ 缺口补充 ============ */

export interface SupplementGapInput {
  conceptId: string;
  conceptName: string;
  /** 缺口理由，来自前置关系的 reason */
  reason: string;
  materials: MaterialSlice[];
}

export interface SupplementGapOutput {
  /** 补充正文（纯文本；200—400 字的目标区间由校验层把关） */
  content: string;
  /**
   * 结构化数学断言（`B3`）：**模型不再自己宣称结论是对的**，
   * 而是把结论写成 `MathClaim` 交给符号引擎逐条核验。
   * 类型是 `unknown[]`：这里不替校验层假定形状，形状非法由 `symbolic.ts` 判 `unverified`。
   */
  claims: unknown[];
}

/**
 * 生成缺口补充。
 *
 * 返回值由 `{content}` 扩为 `{content, claims}`（`B3`）：提示词已改为要求 JSON + 结构化断言。
 *
 * ⚠️ **模型没按 JSON 回时的处置**：此时把原文当正文、`claims` 记为空数组
 * —— 于是验证状态如实落 `unverified`（**不阻断答疑**，也不假装结论已验证）。
 * 不抛错：抛错会让"模型没照格式回"升级成整条请求失败，而内容本身仍是有用的补充说明。
 */
export async function supplementGap(
  call: ModelCaller,
  input: SupplementGapInput,
): Promise<SupplementGapOutput> {
  const prompt = [
    `需要补齐的前置概念：${input.conceptName}（${input.conceptId}）`,
    `判定为缺口的理由：${input.reason}`,
    '',
    '学生当前材料：',
    renderMaterials(input.materials),
  ].join('\n');

  const raw = await call(prompt, { system: SYSTEM_GAP, json: true });

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJson(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
    return {
      content: parsed.content.trim(),
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    };
  }

  return { content: raw.trim(), claims: [] };
}

/* ============ 按材料出题 ============ */

export interface GenerateQuizInput {
  topic: Topic;
  count: number;
  materials: MaterialSlice[];
}

export async function generateQuizFromMaterial(
  call: ModelCaller,
  input: GenerateQuizInput,
): Promise<QuizItem[]> {
  const prompt = [
    `主题：${input.topic}`,
    `请生成 ${input.count} 道单选题。`,
    '',
    '学生当前材料：',
    renderMaterials(input.materials),
  ].join('\n');

  const raw = await call(prompt, { system: SYSTEM_QUIZ_FROM_MATERIAL, json: true });
  const parsed = extractJson(raw) as { items?: unknown };
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  const normalized: QuizItem[] = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    normalized.push({
      ...(item as unknown as QuizItem),
      // 生成题缺省「未验证」：模型自出的题不等于经验证的题（§4.2）
      verification: toVerification(item.verification),
    });
  }
  return normalized;
}

/* ============ 答疑 ============ */

export interface AnswerQuestionInput {
  question: string;
  mode: TutorMode;
  /** 空数组表示零材料提问（轻路径） */
  materials: MaterialSlice[];
  knowledgePointId?: string;
  recentAnswers?: RecentAnswer[];
}

export interface AnswerQuestionOutput {
  scope: AnswerScope;
  blocks: AnswerBlock[];
  basedOnMaterial: boolean;
  nextStep?: NextStep;
}

export async function answerQuestion(
  call: ModelCaller,
  input: AnswerQuestionInput,
): Promise<AnswerQuestionOutput> {
  const lines: string[] = [
    `辅导模式：${input.mode}`,
  ];
  if (input.knowledgePointId) {
    lines.push(`当前聚焦知识点：${input.knowledgePointId}`);
  }
  lines.push('', '学生材料：', renderMaterials(input.materials));

  if (input.recentAnswers && input.recentAnswers.length > 0) {
    lines.push('', '最近的问答（仅作上下文，不要重复作答）：');
    for (const item of input.recentAnswers) {
      lines.push(`问：${item.question}`, `答：${item.answer}`);
    }
  }

  lines.push('', `学生的问题：${input.question}`);

  const raw = await call(lines.join('\n'), { system: SYSTEM_TUTOR, json: true });
  const parsed = extractJson(raw) as Record<string, unknown>;

  const blocks: AnswerBlock[] = [];
  for (const item of Array.isArray(parsed.blocks) ? parsed.blocks : []) {
    if (!isPlainObject(item)) continue;
    if (typeof item.content !== 'string' || typeof item.sourceType !== 'string') continue;
    blocks.push({
      content: item.content,
      sourceType: item.sourceType as AnswerBlock['sourceType'],
      citations: Array.isArray(item.citations) ? (item.citations as Citation[]) : [],
      // 模型未提供验证状态时落到「未验证」，绝不默认「已验证」（§4.2）
      verification: toVerification(item.verification),
    });
  }

  // scope 决定"要不要提示缺前置/是否越界"，取值非法时不可原样透传给前端：
  // 落到 'partial' 会让越界问题被当成部分可答，而 'partial' 恰好是最保守的分支
  // （部分可答必须分开说明），因此作为兜底。
  const scope: AnswerScope =
    typeof parsed.scope === 'string' && ANSWER_SCOPES.includes(parsed.scope as AnswerScope)
      ? (parsed.scope as AnswerScope)
      : 'partial';

  const nextStep = isPlainObject(parsed.nextStep)
    ? (parsed.nextStep as unknown as NextStep)
    : undefined;

  return {
    scope,
    blocks,
    // 零材料时明确标记未经材料支撑（说明书 2.1）
    basedOnMaterial: input.materials.length > 0,
    ...(nextStep ? { nextStep } : {}),
  };
}
