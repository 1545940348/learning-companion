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

/* ==================== 概念别名归一（`P-B12`，2026-09-23） ==================== */

/**
 * 明确同义的写法表（键是**书写归一后**的形式）。
 *
 * ### 为什么要有一张表
 *
 * 同一个概念在真实材料里有多种写法：`导数` / `微商` / `derivative`；
 * 或者仅仅多打一个空格、用全角括号。不归一就会出现**两个节点讲同一件事** ——
 * 图谱看着"知识点更多"，但缺口判定会重复、边会指向两个 id（用例 E15 的同义合并要求）。
 *
 * ### 为什么必须**保守**
 *
 * 归一过度比不归一更危险：把 `导数` 与 `微分` 并成一个节点，等于**凭空造了一个不存在的概念**，
 * 之后所有缺口判定都建在它上面。所以这里只收两类：
 * 1. **书写形式差异**（大小写、空格、全角括号、尾部标点）—— 由 `canonicalName` 处理，无争议；
 * 2. **教材里明确互指**的词 —— 就是下面这张表，**逐条可核，只收同义**。
 *
 * ⚠️ **不收**"看起来相近"的词：`微分`／`积分`／`偏导数`／`导数运算` 都**不在**表里，
 * 它们是不同的概念或不同的粒度。
 */
const CONCEPT_ALIASES: Record<string, string> = {
  /* 中文教材里的同义写法 */
  微商: '导数',
  导函数: '导数',
  求导数: '求导',
  /* 英文与中文指同一件事 */
  derivative: '导数',
  differentiation: '求导',
};

/**
 * 书写形式归一：大小写、空格、全角括号、尾部标点都不该让两个概念分裂。
 *
 * 只做**不会改变语义**的变形 —— 这里一个字符的语义都没动。
 */
function canonicalName(name: string): string {
  return name
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[.,;:、。，；：]+$/g, '');
}

/** 概念归一键：先查同义表，再退回书写归一 */
function canonicalKey(name: string): string {
  const base = canonicalName(name);
  return CONCEPT_ALIASES[base] ?? base;
}

/**
 * 别名合并：同义知识点并成一个节点，并把边重指到留下的那个 id。
 *
 * ### 留下的 id 怎么选
 *
 * 取**第一个出现**的（保持模型给的顺序）。刻意不做"按 id 字典序取最小"之类的规则：
 * 那会让结果依赖 id 命名，而 id 是模型生成的、本来就无规律。
 *
 * ### 为什么返回 `mergedIds`
 *
 * 让调用方能**如实报告**"合并了几个"—— 静默合并会让人以为材料本就只有一个概念。
 */
function mergeAliases(
  points: KnowledgePoint[],
  edges: GraphEdge[],
): { points: KnowledgePoint[]; edges: GraphEdge[]; mergedIds: Set<string> } {
  const primaryByKey = new Map<string, string>();
  const remap = new Map<string, string>();
  const kept: KnowledgePoint[] = [];

  for (const point of points) {
    const key = canonicalKey(point.name);
    const primary = primaryByKey.get(key);
    if (primary === undefined) {
      primaryByKey.set(key, point.id);
      remap.set(point.id, point.id);
      kept.push(point);
      continue;
    }
    remap.set(point.id, primary);
  }

  const mergedIds = new Set<string>();
  for (const [from, to] of remap) {
    if (from !== to) mergedIds.add(from);
  }

  const rewired = edges.map((edge) => ({
    ...edge,
    from: remap.get(edge.from) ?? edge.from,
    to: remap.get(edge.to) ?? edge.to,
    /*
     * `reason` 也要改：它是模型写的给学生看的说明，
     * 只改端点会让"连线指向主概念、说明却提着旧 id"（见 `rewriteIds` 的注释）。
     */
    reason: rewriteIds(edge.reason, remap),
  }));

  return { points: kept, edges: rewired, mergedIds };
}

/**
 * 把一段文本里出现的**旧概念 id** 换成合并后的主 id。
 *
 * 为什么必须做：边的 `reason` 是模型写的说明（如"`kp-monotonicity` 需要 `kp-micro`"），
 * 只改 `from`/`to` 而不改 `reason`，学生就会在界面上看到**两个说法**：
 * 连线指向主概念，说明文字却提着一个已经不存在的 id。
 *
 * 实现按"非 id 字符"分词后整词替换 —— **不做子串替换**：
 * `kp-der` 是 `kp-derivative` 的前缀，子串替换会把后者也改坏。
 */
function rewriteIds(text: string, remap: Map<string, string>): string {
  return text
    .split(/([^\w-]+)/)
    .map((token) => remap.get(token) ?? token)
    .join('');
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

  /*
   * 归一顺序（`P-B12`，2026-09-23）：**先合并别名 → 再删自环 → 最后排环**。
   *
   * ⚠️ 这个顺序不能换：合并别名会**产生新的自环**（原本 `A → B`，而 A 与 B 同义被并成一个），
   * 而 `normalizeEdge` 的自环检查发生在合并之前 —— 那时这条边是合法的。
   * 若先排环再合并，这些边会以自环的形式留在图里，图谱就会出现"自己依赖自己"。
   */
  const merged = mergeAliases(points, edges);
  const withoutSelfLoops = merged.edges.filter((edge) => edge.from !== edge.to);

  return { nodes: merged.points, edges: dropCycles(withoutSelfLoops) };
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
  /**
   * 修正重试时带上"上一版未通过验证的原因"（`P-B2`，2026-09-23）。
   *
   * ⚠️ 措辞必须是**具体的失败结论**（哪条断言、期望什么、实际什么），
   * **不能**写成"请通过验证" —— 后者会诱导模型为了过关而改口径，那是真实性红线。
   */
  correctionHint?: string;
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
    /* 修正重试时把"上一版错在哪"带上（见 `supplementGapWithCorrection`） */
    ...(input.correctionHint
      ? ['', '⚠️ 这是修正重试。上一版未通过符号验证，问题如下：', input.correctionHint]
      : []),
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

/* ============ 失败修正回环（`P-B2`，用例 E14；2026-09-23） ============ */

/**
 * 验证报告里**我们用到**的那部分。
 *
 * 刻意只声明这两个字段（而不是 import `SymbolicReport`）：
 * 回环只关心"过没过"与"为什么没过"，把整个报告类型耦合进来会让这个函数的
 * 改动静默牵动 `symbolic.ts` 的实现细节。
 */
export interface SupplementVerification {
  /**
   * 与契约的 `VerificationStatus` **同集合**（不是自己另立一套）——
   * 服务端会把它直接写进响应，两边取值一旦分叉就会出现"验证说 A、响应说 B"。
   */
  status: VerificationStatus;
  notes: string[];
}

export interface SupplementWithCorrectionResult {
  content: string;
  claims: unknown[];
  report: SupplementVerification;
  /** 是否走过修正重试（调用方据此**如实告诉学生**"这一版是修正后的"） */
  corrected: boolean;
  /** 第一次失败的原因（人可读）；未重试时为 `null` */
  firstFailure: string | null;
}

/**
 * 把验证报告翻成**给模型的修正要求**。
 *
 * 要点：说清"上一版哪几条结论没过"，而**绝不**写成"请通过验证" ——
 * 后者会诱导模型为了过关而改口径，那是真实性红线。
 */
function describeFailure(report: SupplementVerification): string {
  const details = report.notes.length > 0 ? report.notes : ['（引擎未给出细节）'];
  return [
    '上一版补充内容没有通过符号验证，涉及下面这几条结论：',
    ...details.map((note) => `- ${note}`),
    '',
    '请只修正与这些结论相关的表述，其余内容保持不变；如果某条结论本身无法成立，',
    '就把它改成能成立的说法或删掉它，不要为了"看起来通过"而更换口径。',
  ].join('\n');
}

/**
 * 带**失败修正回环**的缺口补充（`P-B2`，2026-09-23；用例 E14）。
 *
 * ### 回环是什么、不是什么
 *
 * 第一次生成 → 验证；**若 `failed`**，把失败原因回喂模型**再生成一次** → 再验证。
 *
 * - **只修一次**：无限重试会烧额度，也会把"模型学会猜对断言"误当成质量提升；
 * - **不隐藏第一次的失败**：结果里带着 `firstFailure`，界面据此说明"这一版是修正后的"；
 * - **重试过 ≠ 通过**：第二次仍 `failed` 就还是 `failed`（调用方照常落 `DISPUTED`）。
 *   这条是整条回环的**红线** —— 否则"重试"就成了掩盖失败的遮羞布。
 *
 * ### 为什么 `verify` 作为参数传进来
 *
 * 校验逻辑在 `symbolic.ts`。用参数注入而不是直接 import，是为了让这条回环
 * **可以脱离符号引擎单独测**（传一个假的 `verify` 就能测全三种分支），
 * 同时避免 `tasks.ts ↔ symbolic.ts` 之间产生环。
 */
export async function supplementGapWithCorrection(
  call: ModelCaller,
  input: SupplementGapInput,
  verify: (draft: { content: string; claims: unknown[] }) => SupplementVerification,
): Promise<SupplementWithCorrectionResult> {
  const first = await supplementGap(call, input);
  const firstReport = verify(first);
  if (firstReport.status !== 'failed') {
    return { ...first, report: firstReport, corrected: false, firstFailure: null };
  }

  const firstFailure = describeFailure(firstReport);
  const second = await supplementGap(call, { ...input, correctionHint: firstFailure });
  const secondReport = verify(second);

  return { ...second, report: secondReport, corrected: true, firstFailure };
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
