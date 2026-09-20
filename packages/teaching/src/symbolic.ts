/**
 * 符号验证引擎（`B3`）—— 对应说明书 V2.0 §4.4、选型文档 §3
 *
 * ### 它做什么
 *
 * 模型的数学结论**不以自由文本形式被"读懂"**，而是回**结构化断言**（`MathClaim`），
 * 由本文件逐条校验。这样才可能给出确定结论：通用代数等价判定是难问题，
 * 而课程范围内的有限题型可以用「**符号求导 + 求值/取样**」判掉。
 *
 * ### 它**不**做什么（如实声明，选型文档 §4 已登记）
 *
 * - **不是通用 prover**：只覆盖四类断言；超出即 `unverified`。
 * - **不做区间级严格证明**：`monotonic` 用**取样法**——以"取样点正确"替代"区间证明"，
 *   理论上可能漏判（区间内存在未取样的变号点）。两道补偿：每区间 3 个样本点；
 *   `FIXED_CASES` 里保留硬编码期望值当回归基线。
 * - **不做猜测性修复**：表达式转换失败 / 超限 / 越出课程范围 → 一律 `unverified`。
 *
 * ### 实现上踩到的三个真坑（都实测过，写在这里免得后人重踩）
 *
 * 1. **`derivative()` 对垃圾输入不报错**：`derivative('not-an-expr','x')` → **`0`**，
 *    `derivative('x^2','y')` → **`0`**。也就是说"表达式没被理解"会伪装成一个**合理结论**。
 *    ⇒ 挡它的闸门只能是**白名单转换**（`./latex.ts`），在进引擎之前就拒掉。
 * 2. **`simplify()` 不是判定过程**：实测 `simplify('(x+1)^2 - x^2 - 2*x - 1')` **不归零**
 *    （返回 `(x + 1) ^ 2 - 2 * x - (x ^ 2 + 1)`）。选型文档 §3.2 让 `tangent` 用
 *    "相减后 `simplify` 判 0"，**照抄会产生假红**。
 *    ⇒ 改用 **`rationalize` 的系数向量**：`rationalize('(x+1)^2 - x^2 - 2*x - 1', {}, true)`
 *    返回 `coefficients: [0,0,0]` —— 在**多项式范围内这是完备判定**（不是取样）。
 *    `simplify` 只作为非多项式时的退路。
 * 3. **求值会返回复数或 `Infinity`**：`evaluate('sqrt(x)',{x:-1})` → `Complex`，
 *    `evaluate('1/x',{x:0})` → `Infinity`。都不是本课程范围内的实数结论
 *    ⇒ 一律按"定不了"处理（`unverified`），**不得当成通过**。
 *
 * ### 超时口径（选型文档 §4.4 第 5 条**已订正**）
 *
 * 原文写"仍设超时保护（包裹 `Promise.race` 或执行步数上限）"。**`Promise.race` 是无效的**：
 * `mathjs` 是**同步计算**，`derivative`/`simplify` 一旦开始就占住事件循环，
 * 计时器回调根本轮不到执行 —— "超时"只能等同步计算**结束之后**才生效，保护不了任何东西。
 * ⇒ 本实现采用**输入规模上限**（`SYMBOLIC_LIMITS`）：断言条数、表达式长度、
 * 区间数、极值点个数全部设硬上限，超限即 `unverified` 并说明原因。
 * **不要**再引入 `Promise.race` 形式的"超时保护"。
 */

import { derivative, parse, rationalize, simplify } from 'mathjs';
import type { MathNode } from 'mathjs';
import { SUPPLEMENT_LENGTH } from '@lc/contracts';
import { latexToExpression } from './latex.js';

/** `parse()` 在 `mathjs` 里是重载函数，`ReturnType` 会取到数组那支；这里显式点名 */
type Node = MathNode;

/* ==================== 规模上限（见文件头「超时口径」） ==================== */

export const SYMBOLIC_LIMITS = {
  /** 单次校验最多接受几条断言 */
  maxClaims: 8,
  /** 单条断言的表达式长度上限（字符） */
  maxExpressionLength: 160,
  /** `monotonic` 每个方向最多几个区间 */
  maxIntervalsPerDirection: 4,
  /** `extremum` 最多几个候选点 */
  maxExtremumPoints: 6,
  /** 每个区间取几个样本点（选型文档 §3.2 要求 ≥3） */
  samplesPerInterval: 3,
} as const;

/** 数值比对容差（选型文档 §3.2：统一 `1e-9`，按量级相对放宽） */
export const SYMBOLIC_TOLERANCE = 1e-9;

/** 「在某点应为 0」用的容差（分界点 / 极值点；数值求值会有舍入） */
export const SYMBOLIC_ZERO_TOLERANCE = 1e-6;

/** 交给 `/api/health` 的引擎状态：本模块存在即表示引擎可用（`I5` 的接线依据） */
export const SYMBOLIC_ENGINE = { name: 'mathjs', available: true } as const;

/** `extremum` 判定时试的邻域半径（由小到大都不是唯一解，取第一个能定符号的） */
const EXTREMUM_DELTAS = [0.5, 0.2, 0.05] as const;

/* ==================== 断言的规范化类型 ==================== */

/**
 * 区间。`null` 表示该侧无界：位置 0 的 `null` 是 −∞，位置 1 的 `null` 是 +∞。
 * （`(−∞, −1]` 写成 `[null, -1]`，`[1, +∞)` 写成 `[1, null]`。）
 */
export type Interval = readonly [number | null, number | null];

export interface DerivativeClaim {
  kind: 'derivative';
  expr: string;
  at: number;
  claimed: number;
}

export interface TangentClaim {
  kind: 'tangent';
  expr: string;
  at: number;
  claimed: string;
}

export interface MonotonicClaim {
  kind: 'monotonic';
  expr: string;
  /** 与选型文档 §3.1 的类型逐字一致：区间挂在 `claimed` 下，不是平铺在断言上 */
  claimed: { inc: Interval[]; dec: Interval[] };
}

export interface ExtremumClaim {
  kind: 'extremum';
  expr: string;
  claimed: number[];
}

export type MathClaim = DerivativeClaim | TangentClaim | MonotonicClaim | ExtremumClaim;
export type ClaimKind = MathClaim['kind'];

const CLAIM_KINDS: readonly ClaimKind[] = ['derivative', 'tangent', 'monotonic', 'extremum'];

/* ==================== 报告类型 ==================== */

export type ClaimStatus = 'verified' | 'failed' | 'unverified';

/** 与契约 `VerificationStatus` 的三档一致（`human` 不由本引擎产生） */
export type SymbolicStatus = 'symbolic' | 'failed' | 'unverified';

export interface ClaimCheck {
  index: number;
  kind: string;
  status: ClaimStatus;
  reason: string;
  /** 规范化后的表达式（若转换成功）—— 便于人工核对，不用于判定 */
  expr: string | null;
  /** 用的判据，便于复核。取值如 `rationalize-coefficients` */
  method: string | null;
}

export interface SymbolicReport {
  status: SymbolicStatus;
  checks: ClaimCheck[];
  /** 面向人工的附加说明（取样法的边界、规模上限等） */
  notes: string[];
}

interface Verdict {
  status: ClaimStatus;
  reason: string;
  method: string | null;
}

/* ==================== 基础工具 ==================== */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function closeEnough(a: number, b: number, tolerance = SYMBOLIC_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 求值。**非有限实数一律不通过**（复数 `i`、`Infinity`、`NaN` 都算"定不了"） */
function evaluateAt(node: Node, at: number): { ok: true; value: number } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = node.evaluate({ x: at });
  } catch (error) {
    return { ok: false, reason: `在 x = ${at} 处求值抛错：${messageOf(error)}` };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      reason: `在 x = ${at} 处求值不是有限实数（课程范围要求一元实函数）`,
    };
  }
  return { ok: true, value };
}

function safeDerivative(node: Node): { ok: true; node: Node } | { ok: false; reason: string } {
  try {
    return { ok: true, node: derivative(node, 'x') };
  } catch (error) {
    return { ok: false, reason: `符号求导失败：${messageOf(error)}` };
  }
}

function parseExpression(expr: string): { ok: true; node: Node } | { ok: false; reason: string } {
  try {
    return { ok: true, node: parse(expr) };
  } catch (error) {
    return { ok: false, reason: `表达式无法解析：${messageOf(error)}` };
  }
}

/** 写成可安全嵌入表达式串的数值 */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : `(${value})`;
}

function formatInterval([a, b]: Interval): string {
  return `${a === null ? '−∞' : a}, ${b === null ? '+∞' : b}`;
}

/* ==================== 输入规范化 ==================== */

type BoundKind = { kind: 'finite'; value: number } | { kind: 'neg-inf' } | { kind: 'pos-inf' };

function toBound(raw: unknown): BoundKind | null {
  if (raw === null) return { kind: 'pos-inf' }; // 与 `undefined` 区分：`null` 在区间里写"无界"
  if (typeof raw === 'number' && Number.isFinite(raw)) return { kind: 'finite', value: raw };
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '-∞' || text === '-inf' || text === '-Infinity') return { kind: 'neg-inf' };
    if (text === '∞' || text === '+∞' || text === 'inf' || text === '+inf' || text === 'Infinity') {
      return { kind: 'pos-inf' };
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return { kind: 'finite', value: parsed };
  }
  return null;
}

function toInterval(raw: unknown): Interval | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [rawLow, rawHigh] = raw as [unknown, unknown];

  const lowIsNegInf = rawLow === null && rawHigh !== null;
  const highIsPosInf = rawHigh === null;
  const low: BoundKind | null = lowIsNegInf ? { kind: 'neg-inf' } : toBound(rawLow);
  const high: BoundKind | null = highIsPosInf ? { kind: 'pos-inf' } : toBound(rawHigh);
  if (!low || !high) return null;

  // 位置语义：`[a, b]` 里 a 只能是有限数或 −∞，b 只能是有限数或 +∞
  if (low.kind === 'pos-inf' || high.kind === 'neg-inf') return null;
  if (low.kind === 'finite' && high.kind === 'finite' && !(low.value < high.value)) return null;

  return [low.kind === 'finite' ? low.value : null, high.kind === 'finite' ? high.value : null];
}

function toIntervals(raw: unknown, limit: number): Interval[] | null {
  const list = raw === undefined ? [] : raw;
  if (!Array.isArray(list) || list.length > limit) return null;
  const out: Interval[] = [];
  for (const item of list) {
    const interval = toInterval(item);
    if (!interval) return null;
    out.push(interval);
  }
  return out;
}

/**
 * 把模型返回的**未知形状**规范化成 `MathClaim`。
 * 任何一处不合法都返回 `{ ok: false }` —— 由调用方标 `unverified`，不猜。
 */
function normalizeClaim(raw: unknown): { ok: true; claim: MathClaim } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: '断言不是对象' };

  const kind = raw.kind;
  if (typeof kind !== 'string' || !CLAIM_KINDS.includes(kind as ClaimKind)) {
    return {
      ok: false,
      reason: `未登记的断言类型：${typeof kind === 'string' ? kind : typeof kind}（只支持 ${CLAIM_KINDS.join(' / ')}）`,
    };
  }

  const rawExpr = raw.expr;
  if (typeof rawExpr === 'string' && rawExpr.length > SYMBOLIC_LIMITS.maxExpressionLength) {
    return {
      ok: false,
      reason: `表达式长度 ${rawExpr.length} 超出上限 ${SYMBOLIC_LIMITS.maxExpressionLength}（输入规模上限，不做超时抢占）`,
    };
  }

  const converted = latexToExpression(rawExpr);
  if (!converted.ok) {
    return { ok: false, reason: `表达式转换失败：${converted.reason}` };
  }
  const expr = converted.expr;

  switch (kind as ClaimKind) {
    case 'derivative': {
      const at = asFiniteNumber(raw.at);
      const claimed = asFiniteNumber(raw.claimed);
      if (at === null) return { ok: false, reason: '`at` 不是有限数' };
      if (claimed === null) return { ok: false, reason: '`claimed` 不是有限数' };
      return { ok: true, claim: { kind: 'derivative', expr, at, claimed } };
    }
    case 'tangent': {
      const at = asFiniteNumber(raw.at);
      if (at === null) return { ok: false, reason: '`at` 不是有限数' };
      if (typeof raw.claimed !== 'string') return { ok: false, reason: '`claimed` 必须是切线表达式字符串' };
      return { ok: true, claim: { kind: 'tangent', expr, at, claimed: raw.claimed } };
    }
    case 'monotonic': {
      if (!isPlainObject(raw.claimed)) return { ok: false, reason: '`claimed` 必须是 { inc, dec } 对象' };
      const inc = toIntervals(raw.claimed.inc, SYMBOLIC_LIMITS.maxIntervalsPerDirection);
      if (!inc) {
        return {
          ok: false,
          reason: `\`claimed.inc\` 不是合法区间数组（每向最多 ${SYMBOLIC_LIMITS.maxIntervalsPerDirection} 个、端点须是有限数或 null）`,
        };
      }
      const dec = toIntervals(raw.claimed.dec, SYMBOLIC_LIMITS.maxIntervalsPerDirection);
      if (!dec) {
        return {
          ok: false,
          reason: `\`claimed.dec\` 不是合法区间数组（每向最多 ${SYMBOLIC_LIMITS.maxIntervalsPerDirection} 个、端点须是有限数或 null）`,
        };
      }
      return { ok: true, claim: { kind: 'monotonic', expr, claimed: { inc, dec } } };
    }
    case 'extremum': {
      const list = raw.claimed;
      if (!Array.isArray(list) || list.length > SYMBOLIC_LIMITS.maxExtremumPoints) {
        return {
          ok: false,
          reason: `\`claimed\` 必须是至多 ${SYMBOLIC_LIMITS.maxExtremumPoints} 个数的数组`,
        };
      }
      const points: number[] = [];
      for (const item of list) {
        const point = asFiniteNumber(item);
        if (point === null) return { ok: false, reason: '极值点必须是有限数' };
        points.push(point);
      }
      return { ok: true, claim: { kind: 'extremum', expr, claimed: points } };
    }
  }

  // 兜底（正常到不了）：`kind` 已在上面按白名单过滤过
  return { ok: false, reason: `未登记的断言类型：${String(kind)}` };
}

/* ==================== 四类断言的校验 ==================== */

function checkDerivative(claim: DerivativeClaim, node: Node): Verdict {
  const method = 'symbolic-derivative+numeric-evaluate';
  const derived = safeDerivative(node);
  if (!derived.ok) return { status: 'unverified', reason: derived.reason, method };

  const value = evaluateAt(derived.node, claim.at);
  if (!value.ok) return { status: 'unverified', reason: value.reason, method };

  if (closeEnough(value.value, claim.claimed)) {
    return {
      status: 'verified',
      reason: `符号求导后代入 x = ${claim.at} 得 ${value.value}，与断言的 ${claim.claimed} 一致`,
      method,
    };
  }
  return {
    status: 'failed',
    reason: `符号求导后代入 x = ${claim.at} 得 ${value.value}，与断言的 ${claim.claimed} 不一致`,
    method,
  };
}

function checkTangent(claim: TangentClaim, node: Node): Verdict {
  const fAt = evaluateAt(node, claim.at);
  if (!fAt.ok) return { status: 'unverified', reason: fAt.reason, method: null };

  const derived = safeDerivative(node);
  if (!derived.ok) return { status: 'unverified', reason: derived.reason, method: null };

  const slope = evaluateAt(derived.node, claim.at);
  if (!slope.ok) return { status: 'unverified', reason: slope.reason, method: null };

  const claimed = latexToExpression(claim.claimed);
  if (!claimed.ok) {
    return { status: 'unverified', reason: `切线断言转换失败：${claimed.reason}`, method: null };
  }

  const difference = `(${num(fAt.value)}) + (${num(slope.value)}) * (x - (${num(claim.at)})) - (${claimed.expr})`;

  /*
   * 首选 `rationalize`：**多项式范围内，系数全零 ⟺ 两式恒等**（完备判定，不是取样）。
   * 这也是对选型文档 §3.2 的订正 —— `simplify` 会漏判（见文件头坑 2）。
   */
  try {
    const rational = rationalize(difference, {}, true) as { coefficients?: unknown };
    const coefficients = Array.isArray(rational?.coefficients) ? rational.coefficients : null;
    if (coefficients && coefficients.length > 0) {
      const numeric = coefficients.filter((item): item is number => typeof item === 'number');
      if (numeric.length === coefficients.length) {
        const worst = Math.max(...numeric.map((item) => Math.abs(item)));
        if (worst <= SYMBOLIC_TOLERANCE) {
          return {
            status: 'verified',
            reason: `把切线式与断言式相减后化为多项式，各项系数全为 0（最大 |系数| = ${worst}）⇒ 两式恒等`,
            method: 'rationalize-coefficients',
          };
        }
        return {
          status: 'failed',
          reason: `把切线式与断言式相减后化为多项式，并非 0（最大 |系数| = ${worst}）⇒ 两式不等`,
          method: 'rationalize-coefficients',
        };
      }
    }
  } catch {
    // 非多项式（如含 sqrt）会抛错 → 落到下面的 simplify 退路
  }

  try {
    const simplified = simplify(difference).toString().trim();
    if (simplified === '0') {
      return { status: 'verified', reason: '两式相减后化简为 0 ⇒ 恒等', method: 'simplify-identity' };
    }
    return {
      status: 'unverified',
      reason: `两式之差既不是多项式也算不到 0（mathjs.simplify 不是判定过程），**未据以判定**：${simplified}`,
      method: 'simplify-inconclusive',
    };
  } catch (error) {
    return {
      status: 'unverified',
      reason: `两式之差既不是多项式、化简也失败（${messageOf(error)}），未据以判定`,
      method: 'simplify-error',
    };
  }
}

/** 区间取样点：有界取"两侧内侧 + 中点"，无界取离分界点 0.5 / 2 / 10 的三点 */
function samplePoints([low, high]: Interval): number[] | null {
  if (low === null && high === null) return null;
  if (low === null) return [high! - 0.5, high! - 2, high! - 10];
  if (high === null) return [low + 0.5, low + 2, low + 10];
  const width = high - low;
  return [low + width * 0.1, (low + high) / 2, high - width * 0.1];
}

function checkMonotonic(claim: MonotonicClaim, node: Node): Verdict {
  const method = 'interval-sampling+endpoint-zero';
  const { inc, dec } = claim.claimed;
  const total = inc.length + dec.length;
  if (total === 0) {
    return { status: 'unverified', reason: '未声明任何单调区间，没有可校验的内容', method };
  }

  const derived = safeDerivative(node);
  if (!derived.ok) return { status: 'unverified', reason: derived.reason, method };

  const targets: { interval: Interval; increasing: boolean }[] = [
    ...inc.map((interval) => ({ interval, increasing: true })),
    ...dec.map((interval) => ({ interval, increasing: false })),
  ];

  for (const { interval, increasing } of targets) {
    const points = samplePoints(interval);
    if (!points) {
      return {
        status: 'unverified',
        reason: `区间 (${formatInterval(interval)}) 两端都无界，取样法覆盖不了整条实轴（如实标未验证，不假装通过）`,
        method,
      };
    }

    for (const point of points) {
      const value = evaluateAt(derived.node, point);
      if (!value.ok) return { status: 'unverified', reason: value.reason, method };

      if (Math.abs(value.value) <= SYMBOLIC_ZERO_TOLERANCE) {
        return {
          status: 'unverified',
          reason: `取样点 x = ${point} 处 f′(x) ≈ 0，该点的符号定不了，据此刻不了结论`,
          method,
        };
      }
      const signMatches = increasing ? value.value > 0 : value.value < 0;
      if (!signMatches) {
        return {
          status: 'failed',
          reason: `断言 ${increasing ? '递增' : '递减'} 的区间 (${formatInterval(interval)}) 内，取样点 x = ${point} 的 f′(x) = ${value.value} 方向相反`,
          method,
        };
      }
    }
  }

  /*
   * 分界点校验：出现在**两个及以上**区间端点上的有限值，应当是 f′(b) = 0 的驻点。
   * （只在"被共享的端点"上要求为 0 —— 区间外侧的无界端没有可校验的边界。）
   */
  const endpointCount = new Map<number, number>();
  for (const { interval } of targets) {
    for (const bound of interval) {
      if (bound === null) continue;
      endpointCount.set(bound, (endpointCount.get(bound) ?? 0) + 1);
    }
  }

  for (const [bound, count] of endpointCount) {
    if (count < 2) continue;
    const value = evaluateAt(derived.node, bound);
    if (!value.ok) return { status: 'unverified', reason: value.reason, method };
    if (Math.abs(value.value) > SYMBOLIC_ZERO_TOLERANCE) {
      return {
        status: 'failed',
        reason: `区间分界点 x = ${bound} 处 f′(x) = ${value.value} ≠ 0，与"这里是增减分界"矛盾`,
        method,
      };
    }
  }

  return {
    status: 'verified',
    reason: `每个声明区间各取 ${SYMBOLIC_LIMITS.samplesPerInterval} 个样本点，f′(x) 符号与断言一致；共 ${endpointCount.size} 个候选分界点里被共享的那些满足 f′(边界) = 0（取样法，非区间级严格证明）`,
    method,
  };
}

function checkExtremum(claim: ExtremumClaim, node: Node): Verdict {
  const method = 'first-derivative-sign-change';
  if (claim.claimed.length === 0) {
    return { status: 'unverified', reason: '未声明任何极值点', method };
  }

  const derived = safeDerivative(node);
  if (!derived.ok) return { status: 'unverified', reason: derived.reason, method };

  for (const point of claim.claimed) {
    const at = evaluateAt(derived.node, point);
    if (!at.ok) return { status: 'unverified', reason: at.reason, method };
    if (Math.abs(at.value) > SYMBOLIC_ZERO_TOLERANCE) {
      return {
        status: 'failed',
        reason: `x = ${point} 处 f′(x) = ${at.value} ≠ 0，不是驻点，故不是极值点`,
        method,
      };
    }

    let decided: Verdict | null = null;
    for (const delta of EXTREMUM_DELTAS) {
      const left = evaluateAt(derived.node, point - delta);
      const right = evaluateAt(derived.node, point + delta);
      if (!left.ok || !right.ok) continue;
      // 一侧取到 0 → 这个半径跨过了别的驻点，定不了，换下一档
      if (
        Math.abs(left.value) <= SYMBOLIC_ZERO_TOLERANCE ||
        Math.abs(right.value) <= SYMBOLIC_ZERO_TOLERANCE
      ) {
        continue;
      }
      if (left.value * right.value < 0) {
        decided = {
          status: 'verified',
          reason: `x = ${point} 处 f′(x) = 0，且左右邻域（±${delta}）符号相反（${left.value} → ${right.value}）⇒ 变号，是极值点`,
          method,
        };
      } else {
        decided = {
          status: 'failed',
          reason: `x = ${point} 处 f′(x) = 0，但左右邻域（±${delta}）符号相同（${left.value} / ${right.value}）⇒ 不变号，不是极值点`,
          method,
        };
      }
      break;
    }

    if (!decided) {
      return {
        status: 'unverified',
        reason: `x = ${point} 的邻域内 f′(x) 在每个试过的半径上都被 0 或非实数占住，变号与否定不了`,
        method,
      };
    }
    if (decided.status !== 'verified') return decided;
  }

  return {
    status: 'verified',
    reason: `${claim.claimed.length} 个候选点均满足 f′(x) = 0 且左右邻域符号相反`,
    method,
  };
}

/* ==================== 对外入口 ==================== */

/**
 * 校验一组断言。
 *
 * 汇总口径（**从严**）：
 * - 任一条 `failed` → 整体 `failed`（→ §3.4 的修正回环 / `DISPUTED`）；
 * - 全部 `verified` → 整体 `symbolic`；
 * - 其余（含"一条没过、一条定不了"）→ 整体 `unverified`。
 *
 * ⚠️ **"没有断言"不是"通过"**：没有可校验的结论时返回 `unverified`，
 * 绝不返回 `symbolic`（说明书 §4.2：未验证内容不得默认视为正确）。
 */
export function verifyClaims(rawClaims: unknown): SymbolicReport {
  const notes: string[] = [];
  const checks: ClaimCheck[] = [];

  if (!Array.isArray(rawClaims)) {
    return {
      status: 'unverified',
      checks,
      notes: ['未提供结构化断言（`claims` 不是数组）⇒ 无内容可校验，如实标未验证'],
    };
  }
  if (rawClaims.length === 0) {
    return {
      status: 'unverified',
      checks,
      notes: ['未提供任何断言 ⇒ 无内容可校验，如实标未验证（"没有断言"不等于"通过"）'],
    };
  }
  if (rawClaims.length > SYMBOLIC_LIMITS.maxClaims) {
    return {
      status: 'unverified',
      checks,
      notes: [
        `断言条数 ${rawClaims.length} 超出上限 ${SYMBOLIC_LIMITS.maxClaims}（输入规模上限）⇒ 整体不校验`,
      ],
    };
  }

  rawClaims.forEach((raw, index) => {
    const normalized = normalizeClaim(raw);
    if (!normalized.ok) {
      checks.push({
        index,
        kind: isPlainObject(raw) && typeof raw.kind === 'string' ? raw.kind : 'unknown',
        status: 'unverified',
        reason: normalized.reason,
        expr: null,
        method: null,
      });
      return;
    }

    const claim = normalized.claim;
    const parsed = parseExpression(claim.expr);
    if (!parsed.ok) {
      checks.push({
        index,
        kind: claim.kind,
        status: 'unverified',
        reason: parsed.reason,
        expr: claim.expr,
        method: null,
      });
      return;
    }

    const verdict =
      claim.kind === 'derivative'
        ? checkDerivative(claim, parsed.node)
        : claim.kind === 'tangent'
          ? checkTangent(claim, parsed.node)
          : claim.kind === 'monotonic'
            ? checkMonotonic(claim, parsed.node)
            : checkExtremum(claim, parsed.node);

    checks.push({
      index,
      kind: claim.kind,
      status: verdict.status,
      reason: verdict.reason,
      expr: claim.expr,
      method: verdict.method,
    });
  });

  const failed = checks.some((check) => check.status === 'failed');
  const allVerified = checks.length > 0 && checks.every((check) => check.status === 'verified');
  notes.push(
    `逐条结果：verified ${checks.filter((c) => c.status === 'verified').length} / failed ${checks.filter((c) => c.status === 'failed').length} / unverified ${checks.filter((c) => c.status === 'unverified').length}`,
  );
  notes.push(
    '判据是"符号求导 + 多项式系数判定 / 区间取样"，**不做区间级严格证明**（选型文档 §3.2/§4 已登记该限制）',
  );

  return { status: failed ? 'failed' : allVerified ? 'symbolic' : 'unverified', checks, notes };
}

/** 按**非空白字符**计长度（"200—400 字"说的是内容量，换行与缩进不算） */
export function countSupplementCharacters(content: string): number {
  return Array.from(content).filter((char) => !/\s/.test(char)).length;
}

/**
 * 补充内容的验证状态：先看**规模**（长度），再看结构化断言。
 *
 * 为什么把长度也算进"能不能标已验证"：`SUPPLEMENT_LENGTH`（200—400）是契约里
 * 声明了却一直没人用的常量（`I18`）。超出区间的补充内容**仍然是可用的补充内容**，
 * 但它没有满足"可标已符号验证"的完整条件 ⇒ 标 `unverified` 并把原因写出来，
 * **不阻断答疑、也不截断内容**（截断会悄悄改掉内容，比标未验证更糟）。
 */
export function verifySupplementContent(input: { content: string; claims: unknown }): SymbolicReport {
  const report = verifyClaims(input.claims);
  const length = countSupplementCharacters(input.content);

  if (length < SUPPLEMENT_LENGTH.min || length > SUPPLEMENT_LENGTH.max) {
    return {
      ...report,
      status: report.status === 'failed' ? 'failed' : 'unverified',
      notes: [
        ...report.notes,
        `补充内容 ${length} 字，超出目标区间 ${SUPPLEMENT_LENGTH.min}—${SUPPLEMENT_LENGTH.max} 字 ⇒ 不据此标「已符号验证」（内容照常返回）`,
      ],
    };
  }
  return { ...report, notes: [...report.notes, `补充内容 ${length} 字，在目标区间内`] };
}

/* ==================== 固定案例基线（P-B16） ==================== */

export interface FixedCase {
  id: string;
  topic: ClaimKind;
  /** 期望的整体结论 */
  expect: SymbolicStatus;
  /** 人可读说明；`§7.1` 指说明书 `docs/specs/微积分学伴_项目说明书.md` §7.1 */
  description: string;
  claim: MathClaim;
}

/**
 * 固定案例表 —— **只此一份**（`P-B16` 要求回归脚本与实现共用同一期望值）。
 *
 * F1–F3 逐条对应说明书 §7.1 的三个自编案例；F4 是 F3 的分界点（§4.4 要求校验极值点）；
 * **F5–F7 是负例**、**F8–F10 是越界例**。
 *
 * 为什么必须有负例与越界例：本项目吃过"恒真断言"的亏（`I24`）。只有正例的基线
 * 证明不了校验器**有分辨力** —— 一个"永远返回 verified"的实现也能全过正例。
 */
export const FIXED_CASES: readonly FixedCase[] = [
  {
    id: 'F1',
    topic: 'derivative',
    expect: 'symbolic',
    description: '§7.1 导数：x² 在 1 处导数为 2',
    claim: { kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 },
  },
  {
    id: 'F2',
    topic: 'tangent',
    expect: 'symbolic',
    description: '§7.1 切线：x² 在 (1, 1) 处的切线 y = 2x − 1',
    claim: { kind: 'tangent', expr: 'x^2', at: 1, claimed: '2x - 1' },
  },
  {
    id: 'F3',
    topic: 'monotonic',
    expect: 'symbolic',
    description: '§7.1 单调性：x³ − 3x 在 (−∞,−1)、(1,+∞) 递增，在 (−1,1) 递减',
    claim: {
      kind: 'monotonic',
      expr: 'x^3 - 3x',
      claimed: {
        inc: [
          [null, -1],
          [1, null],
        ],
        dec: [[-1, 1]],
      },
    },
  },
  {
    id: 'F4',
    topic: 'extremum',
    expect: 'symbolic',
    description: 'F3 的分界点：x³ − 3x 在 x = ±1 处取极值（§4.4 要求校验极值点）',
    claim: { kind: 'extremum', expr: 'x^3 - 3x', claimed: [-1, 1] },
  },
  {
    id: 'F5',
    topic: 'derivative',
    expect: 'failed',
    description: '负例：把 x² 在 1 处的导数误报为 3 —— 必须判「验证未通过」',
    claim: { kind: 'derivative', expr: 'x^2', at: 1, claimed: 3 },
  },
  {
    id: 'F6',
    topic: 'tangent',
    expect: 'failed',
    description: '负例：把 x² 在 (1, 1) 处的切线误报为 y = 2x + 1 —— 必须判「验证未通过」',
    claim: { kind: 'tangent', expr: 'x^2', at: 1, claimed: '2x + 1' },
  },
  {
    id: 'F7',
    topic: 'monotonic',
    expect: 'failed',
    description: '负例：把 x³ − 3x 的增减区间写反 —— 必须判「验证未通过」',
    claim: {
      kind: 'monotonic',
      expr: 'x^3 - 3x',
      claimed: {
        inc: [[-1, 1]],
        dec: [
          [null, -1],
          [1, null],
        ],
      },
    },
  },
  {
    id: 'F8',
    topic: 'derivative',
    expect: 'unverified',
    description: '越界：三角函数不在课程范围内 —— 必须标「未验证」，不得假装通过',
    claim: { kind: 'derivative', expr: '\\sin{x}', at: 1, claimed: 1 },
  },
  {
    id: 'F9',
    topic: 'derivative',
    expect: 'unverified',
    description:
      '越界：表达式长度超出输入规模上限 —— 必须标「未验证」（超时口径用规模上限，不用 Promise.race）',
    claim: { kind: 'derivative', expr: `${'1+'.repeat(200)}1`, at: 1, claimed: 1 },
  },
  {
    id: 'F10',
    topic: 'derivative',
    expect: 'unverified',
    description:
      '越界：变量 y 不在白名单（实测 `derivative("x^2","y")` 会静默返回 0，所以必须在这里挡住）',
    claim: { kind: 'derivative', expr: 'y^2', at: 1, claimed: 2 },
  },
];

export interface FixedCaseOutcome {
  id: string;
  expect: SymbolicStatus;
  actual: SymbolicStatus;
  passed: boolean;
  status: ClaimStatus;
  reason: string;
}

/** 跑一遍固定案例表，返回逐条结论（供 `verify-symbolic.mjs` 断言） */
export function runFixedCases(): FixedCaseOutcome[] {
  return FIXED_CASES.map((item) => {
    const report = verifyClaims([item.claim]);
    const first = report.checks[0];
    return {
      id: item.id,
      expect: item.expect,
      actual: report.status,
      passed: report.status === item.expect,
      status: first?.status ?? 'unverified',
      reason: first?.reason ?? report.notes.join('；'),
    };
  });
}
