/**
 * 入参形状校验（说明书 5.2 共享类型、V1.4 第 9.3 节）
 *
 * ### 为什么需要这一层
 *
 * 路由此前直接 `body.materials ?? []` 后当数组使用。实测把 `materials` 传成字符串或
 * 缺 `text` 的对象，都会在 `checkMaterialQuota` 里抛 `TypeError`，最终变成
 * **500 `INTERNAL`：Cannot read properties of undefined (reading 'length')** ——
 * 状态码错了，内部实现细节也回给了客户端。
 *
 * 这些是**客户端把请求写错了**，应当是 400 `BAD_REQUEST` 且文案说清哪个字段不对。
 *
 * ### 设计约定
 *
 * - 全部是纯函数，返回 `{ ok: true, value }` 或 `{ ok: false, problem }`，
 *   **不抛异常、不依赖 express** —— 与 store 层的 `checkMaterialQuota` 同一惯用法，
 *   因此可以直接单测（scripts/verify-guards-and-errors.mjs）。
 * - 只在"会污染状态或让请求含义不明"的地方收紧；能给出合理默认值的字段给默认值，
 *   避免为了严格而拦住 A 的正常调用。
 */

import type { Material, MaterialKind, RecentAnswer, Topic, TutorMode } from '@lc/contracts';
import { TOPIC_LABELS } from '@lc/contracts';

export type Guard<T> = { ok: true; value: T } | { ok: false; problem: string };

const ok = <T>(value: T): Guard<T> => ({ ok: true, value });
const fail = <T>(problem: string): Guard<T> => ({ ok: false, problem });

const MATERIAL_KINDS: readonly MaterialKind[] = ['upload', 'ai-supplement'];
const TUTOR_MODES: readonly TutorMode[] = ['explain', 'hint', 'full'];
const TOPICS: readonly string[] = Object.keys(TOPIC_LABELS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyText(value: unknown, field: string): Guard<string> {
  if (typeof value !== 'string') return fail(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(`${field} 不能为空`);
  return ok(trimmed);
}

/* ==================== 会话与版本 ==================== */

/** 必填的非空字符串（`conceptId`、`reason` 等） */
export function guardNonEmptyText(raw: unknown, field: string): Guard<string> {
  return readNonEmptyText(raw, field);
}

/** 可选的非空字符串：缺失或为 null 都视为"未提供" */
export function guardOptionalText(raw: unknown, field: string): Guard<string | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  return readNonEmptyText(raw, field);
}

/** 必须有会话的接口（/knowledge、/gap） */
export function guardSessionId(raw: unknown): Guard<string> {
  return guardNonEmptyText(raw, 'sessionId');
}

/**
 * 可为空的会话：`/tutor` 允许轻路径（零材料提问）。
 *
 * 契约里 `sessionId` 的类型是 `string | null`（**必填**），null 表示轻路径。
 * 因此字段被省略时既不是会话 ID 也不是 null，属于调用方写错，
 * 明确报 400 并告诉他轻路径要显式传 null —— 而不是被下游当成别的问题。
 */
export function guardNullableSessionId(raw: unknown): Guard<string | null> {
  if (raw === null) return ok(null);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return ok(null);
    return ok(trimmed);
  }
  return fail('sessionId 必须是会话 ID 或 null（轻路径请显式传 null）');
}

export function guardMaterialVersion(raw: unknown, field = 'materialVersion'): Guard<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return fail(`${field} 必须是不小于 0 的整数`);
  }
  return ok(raw);
}

/* ==================== 材料 ==================== */

function guardMaterial(raw: unknown, index: number): Guard<Material> {
  if (!isPlainObject(raw)) return fail(`materials[${index}] 必须是对象`);

  const { id, kind, text, lowConfidence, createdAt } = raw;

  const idGuard = readNonEmptyText(id, `materials[${index}].id`);
  if (!idGuard.ok) return fail(idGuard.problem);

  if (typeof text !== 'string') return fail(`materials[${index}].text 必须是字符串`);

  let resolvedKind: MaterialKind = 'upload';
  if (kind !== undefined) {
    if (typeof kind !== 'string' || !MATERIAL_KINDS.includes(kind as MaterialKind)) {
      return fail(`materials[${index}].kind 只允许 ${MATERIAL_KINDS.join(' / ')}`);
    }
    resolvedKind = kind as MaterialKind;
  }

  const material: Material = {
    id: idGuard.value,
    kind: resolvedKind,
    text,
    // 时间戳由服务端兜底，避免调用方漏传导致类型不成立
    createdAt:
      typeof createdAt === 'string' && createdAt.length > 0
        ? createdAt
        : new Date().toISOString(),
  };
  if (Array.isArray(lowConfidence)) {
    material.lowConfidence = lowConfidence as Material['lowConfidence'];
  }
  return ok(material);
}

/** 缺省视为空数组（表示"只基于现有材料分析"） */
export function guardMaterials(raw: unknown): Guard<Material[]> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) return fail('materials 必须是数组');
  const materials: Material[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const guarded = guardMaterial(raw[index], index);
    if (!guarded.ok) return fail(guarded.problem);
    materials.push(guarded.value);
  }
  return ok(materials);
}

/* ==================== 答疑 ==================== */

export function guardQuestion(raw: unknown): Guard<string> {
  return readNonEmptyText(raw, 'question');
}

/** 契约里 mode 必填；缺失时按产品默认给 explain，取值非法才报错 */
export function guardMode(raw: unknown): Guard<TutorMode> {
  if (raw === undefined || raw === null) return ok('explain');
  if (typeof raw === 'string' && TUTOR_MODES.includes(raw as TutorMode)) {
    return ok(raw as TutorMode);
  }
  return fail(`mode 只允许 ${TUTOR_MODES.join(' / ')}`);
}

export function guardRecentAnswers(raw: unknown): Guard<RecentAnswer[] | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (!Array.isArray(raw)) return fail('recentAnswers 必须是数组');
  const answers: RecentAnswer[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!isPlainObject(item)) return fail(`recentAnswers[${index}] 必须是对象`);
    const { question, answer } = item;
    if (typeof question !== 'string' || typeof answer !== 'string') {
      return fail(`recentAnswers[${index}] 的 question 与 answer 必须是字符串`);
    }
    answers.push({ question, answer });
  }
  return ok(answers);
}

/* ==================== 练习 ==================== */

/** 课程范围严格限定为三个主题（说明书 2.6）；不在范围内直接报错，不返回空题集 */
export function guardTopic(raw: unknown): Guard<Topic> {
  if (typeof raw === 'string' && TOPICS.includes(raw)) return ok(raw as Topic);
  return fail(`topic 只允许 ${TOPICS.join(' / ')}`);
}

export function guardQuizSource(raw: unknown): Guard<'fixed' | 'material'> {
  if (raw === undefined || raw === null || raw === '') return ok('fixed');
  if (raw === 'fixed' || raw === 'material') return ok(raw);
  return fail('source 只允许 fixed / material');
}
