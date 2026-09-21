/**
 * 视觉识别的**输出解析层**：把模型返回的原始文本，变成契约要求的结构。
 *
 * ### 为什么与 `vision.ts` 分开
 *
 * `vision.ts` 管"**怎么把图送出去**"（载荷校验、调用模型、错误口径）；
 * 本文件管"**怎么把回的东西读懂**"（JSON 提取、字段校验、偏移定位、
 * `notToScale` 规则）。两者变化的原因不同：换通道动前者，改字段规范动后者。
 * 分开后各自都在项目 300 行闸门内，也各自可被单独断言。
 *
 * ### 本层的两条硬纪律
 *
 * 1. **不编造数据。** 公式与低置信度片段都要求 `start/end`（契约 `api.ts`
 *    L114-119 / `session.ts` L16-21），而模型**不会**给出可靠偏移 ——
 *    所以本层在正文里**定位**它们：**定位不到就丢弃该条**，
 *    绝不写 `start:0,end:0` 这类看起来合规、实则错误的占位值。
 * 2. **`notToScale` 为真时必须丢掉数值。** 契约明文（`api.ts` L127-128）：
 *    无刻度示意图不得据此估算精确数值。丢的是 `x`/`y`，保留 `label`。
 */

import type { FormulaSpan, ImageStructure, LowConfidenceSpan } from '@lc/contracts';

/** 识别文本的长度上限：防止模型输出异常膨胀后被打进材料库 */
export const MAX_RECOGNIZED_CHARS = 8000;

/** 解析成功时的结构（字段与 `ParseResponse` 对齐） */
export interface ParsedVisionOutput {
  text: string;
  imageDescription?: string;
  imageStructure?: ImageStructure;
  formulas: FormulaSpan[];
  lowConfidence: LowConfidenceSpan[];
}

/**
 * 解析结果。**失败不抛异常**（调用方据此决定降级还是报错）：
 * - `not-json`：模型没按结构化格式返回 → 调用方降级为纯文本；
 * - `empty`：解析出来但没有可用的 text → 调用方给出可操作的 400。
 */
export type InterpretedOutput =
  | { ok: true; value: ParsedVisionOutput }
  | { ok: false; reason: 'not-json'; rawText: string }
  | { ok: false; reason: 'empty' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 从模型输出里取出 JSON：先整体解析，再退化为"首个 `{` 到末个 `}`" */
function extractJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 继续尝试下一个候选；全都失败则返回 null，由调用方降级
    }
  }
  return null;
}

/** 在正文里定位片段，得到契约要求的 `start/end`；定位不到返回 null（**不写假偏移**） */
function locate(text: string, needle: string): { start: number; end: number } | null {
  const at = text.indexOf(needle);
  if (at < 0) return null;
  return { start: at, end: at + needle.length };
}

/** 公式：只保留能在正文里定位到的（保证 `start/end` 真实） */
function parseFormulas(source: Record<string, unknown>, text: string): FormulaSpan[] {
  const list = source['formulas'];
  if (!Array.isArray(list)) return [];
  const out: FormulaSpan[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const latex = item.trim();
    if (latex.length === 0) continue;
    // 模型给的 LaTeX 与正文写法常不一致（`$...$` 包裹、空格），三种写法都试
    const span =
      locate(text, latex) ??
      locate(text, `$${latex}$`) ??
      locate(text, latex.replace(/\s/g, ''));
    if (span === null) continue;
    out.push({ start: span.start, end: span.end, latex });
  }
  return out;
}

/** 低置信度片段：同样只保留能定位到的，并把偏移夹在正文范围内 */
function parseLowConfidence(
  source: Record<string, unknown>,
  text: string,
): LowConfidenceSpan[] {
  const list = source['lowConfidence'];
  if (!Array.isArray(list)) return [];
  const out: LowConfidenceSpan[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const fragment = typeof item['text'] === 'string' ? item['text'].trim() : '';
    const reason = typeof item['reason'] === 'string' ? item['reason'].trim() : '模型未说明原因';
    if (fragment.length === 0) continue;
    const span = locate(text, fragment);
    if (span === null) continue;
    out.push({
      start: Math.max(0, Math.min(span.start, text.length)),
      end: Math.max(0, Math.min(span.end, text.length)),
      reason,
    });
  }
  return out;
}

/** 图像结构；`notToScale` 为真时**丢弃数值型关键点**（契约明文要求） */
function parseImageStructure(source: Record<string, unknown>): ImageStructure | undefined {
  const raw = source['imageStructure'];
  if (!isRecord(raw)) return undefined;

  const structure: ImageStructure = {};
  const chartType = pickString(raw, 'chartType');
  if (chartType !== undefined) structure.chartType = chartType;
  const trend = pickString(raw, 'trend');
  if (trend !== undefined) structure.trend = trend;

  const axes = raw['axes'];
  if (isRecord(axes)) {
    const x = pickString(axes, 'x');
    const y = pickString(axes, 'y');
    if (x !== undefined || y !== undefined) {
      structure.axes = { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
    }
  }

  const notToScale = raw['notToScale'] === true;
  if (notToScale) structure.notToScale = true;

  const points = raw['keyPoints'];
  if (Array.isArray(points)) {
    const kept: NonNullable<ImageStructure['keyPoints']> = [];
    for (const point of points) {
      if (!isRecord(point)) continue;
      const label = pickString(point, 'label');
      if (label === undefined) continue;
      // 无刻度示意图：只留 label，数值一律丢掉 —— 不据示意图估数值（§2.2）
      if (notToScale) {
        kept.push({ label });
        continue;
      }
      const x = typeof point['x'] === 'number' && Number.isFinite(point['x']) ? point['x'] : undefined;
      const y = typeof point['y'] === 'number' && Number.isFinite(point['y']) ? point['y'] : undefined;
      kept.push({ label, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) });
    }
    if (kept.length > 0) structure.keyPoints = kept;
  }

  return Object.keys(structure).length > 0 ? structure : undefined;
}

/**
 * 解读模型输出。
 *
 * @param raw 模型返回的原始文本
 * @param prefix 需要在正文最前面保留的内容（学生自己写的字）；**在定位之前拼入**，
 *   因此公式与低置信度的偏移天然指向最终正文，不需要额外换算。
 */
export function interpretModelOutput(raw: string, prefix = ''): InterpretedOutput {
  const parsed = extractJson(raw);
  if (parsed === null) {
    return { ok: false, reason: 'not-json', rawText: (prefix + raw.trim()).slice(0, MAX_RECOGNIZED_CHARS) };
  }

  // 先截断再定位：否则截断会让已经算好的偏移指向正文之外
  const text = (prefix + (pickString(parsed, 'text') ?? '')).slice(0, MAX_RECOGNIZED_CHARS);
  if (text.length === 0) return { ok: false, reason: 'empty' };

  const formulas = parseFormulas(parsed, text);
  const lowConfidence = parseLowConfidence(parsed, text);
  const imageDescription = pickString(parsed, 'imageDescription');
  const imageStructure = parseImageStructure(parsed);

  return {
    ok: true,
    value: {
      text,
      formulas,
      lowConfidence,
      ...(imageDescription !== undefined ? { imageDescription } : {}),
      ...(imageStructure !== undefined ? { imageStructure } : {}),
    },
  };
}
