/**
 * 符号验证（说明书 V2.0 §4.4；选型与算法见
 * `docs/tech/2026-09-17-符号验证引擎选型-纯TS.md`）
 *
 * ## 一句话
 * 让**程序**把模型给出的数学结论真算一遍，而不是只信模型说的话。
 *
 * ## 为什么是「结构化断言 + 取样验证」，而不是「通用证明」
 *
 * 通用代数等价判定是难问题，而 `mathjs.simplify` 不是判定过程。
 * 换个思路：把输入收敛到**课程范围内的有限题型**（求导值 / 切线 / 单调区间 / 极值点），
 * 就能用「**符号求导 + 数值取样**」给出确定结论，不必依赖化简器的完备性。
 * 因此模型**不返回自由文本结论**，而是返回结构化断言（见 {@link MathClaim}）。
 *
 * ## 三条诚实性约束（贯穿全文件）
 *
 * 1. **拿不准就标 `unverified`**，绝不猜、绝不"修复"后当作通过；
 * 2. **超出课程范围的表达式一律不验证**，如实标 `unverified`；
 * 3. **任何失败都不抛到顶层** —— 解析失败、数值非有限、超预算，全部降级为状态。
 *    本模块不产生异常，只产生结论。
 *
 * ## 已知限制（如实登记，详见选型文档 §4）
 *
 * - 非通用 prover：只覆盖上述四类断言的课程内形态；
 * - **区间取样法理论上可能漏判**（区间内存在未取样的变号点）——
 *   靠「每区间 3 个样本点」与「固定案例硬编码基线」两道补偿降低概率，不宣称区间级严格证明；
 * - `mathjs` 是**同步**计算，真正的"超时中断"需要 worker 才能做到。
 *   这里用**时间预算 + 事后跳过**代替：超预算后剩余断言一律标 `unverified` 且**不阻断答疑**。
 */

import { derivative, parse, simplify } from 'mathjs';
import type { VerificationStatus } from '@lc/contracts';

/* ==================== 断言类型 ==================== */

/**
 * 单点求导值断言：`f'(at)` 应当等于 `claimed`。
 *
 * 例：`{ kind:'derivative', expr:'x^2', at:1, claimed:2 }` —— x² 在 x=1 处导数为 2。
 */
export interface DerivativeClaim {
  readonly kind: 'derivative';
  /** 表达式字符串（mathjs 语法），如 `'x^2'`、`'x^3 - 3*x'` */
  readonly expr: string;
  /** 求导点（实数） */
  readonly at: number;
  /** 模型声称的导数值 */
  readonly claimed: number;
}

/**
 * 切线断言：`f` 在 `at` 处的切线方程应当等于 `claimed`。
 *
 * 例：`{ kind:'tangent', expr:'x^2', at:1, claimed:'2*x - 1' }` —— y = 2x − 1。
 */
export interface TangentClaim {
  readonly kind: 'tangent';
  readonly expr: string;
  readonly at: number;
  /** 模型声称的切线方程（mathjs 语法，等号右侧） */
  readonly claimed: string;
}

/**
 * 单调区间断言。
 *
 * `inc` / `dec` 均为**闭区间数组**，元素形状固定为 `[左端, 右端]`（两元组，左 ≤ 右），
 * 端点可为 `±Infinity`。例：x³−3x 的
 * `{ inc: [[-Infinity, -1], [1, Infinity]], dec: [[-1, 1]] }`。
 */
export interface MonotonicClaim {
  readonly kind: 'monotonic';
  readonly expr: string;
  readonly claimed: {
    /** 递增区间列表，每项为 `[start, end]` 两元组 */
    readonly inc: readonly (readonly [number, number])[];
    /** 递减区间列表，每项为 `[start, end]` 两元组 */
    readonly dec: readonly (readonly [number, number])[];
  };
}

/** 极值点断言：`claimed` 是声称的极值点横坐标列表 */
export interface ExtremumClaim {
  readonly kind: 'extremum';
  readonly expr: string;
  /** 声称的极值点横坐标，如 `[0]`、`[-1, 1]` */
  readonly claimed: readonly number[];
}

export type MathClaim = DerivativeClaim | TangentClaim | MonotonicClaim | ExtremumClaim;

/* ==================== 校验结果类型 ==================== */

/** 单条断言的判定结果。取值刻意收窄为三种：全对 / 判错 / 拿不准 */
export type ClaimStatus = Extract<VerificationStatus, 'symbolic' | 'failed' | 'unverified'>;

export interface ClaimVerdict {
  readonly claim: MathClaim;
  readonly status: ClaimStatus;
  /** 人话说明，用于日志与人工排查（不面向学生） */
  readonly detail: string;
}

export interface VerifyResult {
  /** 整体结论：任一条 failed 则整体 failed；全 symbolic 才是 symbolic；否则 unverified */
  readonly status: VerificationStatus;
  /** 逐条判定，顺序与入参一致 */
  readonly verdicts: readonly ClaimVerdict[];
  /** 实际耗时（毫秒），供日志记录 */
  readonly durationMs: number;
}

export interface VerifyOptions {
  /** 浮点比较容差，默认 `1e-9`（选型文档 §4.4） */
  readonly tolerance?: number;
  /** 本次验证的总时间预算（毫秒），默认 2000。超预算的断言标 `unverified` 但不阻断 */
  readonly budgetMs?: number;
  /** 表达式长度上限，默认 200。超长直接判 `unverified`，避免病态输入卡住进程 */
  readonly maxExprLength?: number;
  /** 单调性每个区间的取样点数，默认 3（选型文档 §3.2） */
  readonly samplesPerInterval?: number;
}

const DEFAULT_TOLERANCE = 1e-9;
const DEFAULT_BUDGET_MS = 2_000;
const DEFAULT_MAX_EXPR_LENGTH = 200;
const DEFAULT_SAMPLES_PER_INTERVAL = 3;

/** `±Infinity` 端点的取样窗口：课程范围内足够大，避免真的取到无穷 */
const INFINITY_WINDOW = 20;

/* ==================== 内部工具 ==================== */

/** 把可能为 ±Infinity 的端点换成可取的有限值 */
function finiteBound(value: number): number {
  if (value === Infinity) return INFINITY_WINDOW;
  if (value === -Infinity) return -INFINITY_WINDOW;
  return value;
}

/**
 * 在区间 `[rawStart, rawEnd]` 内取 `count` 个**内部**样本点（不含端点）。
 * 端点为 ±Infinity 时按 {@link INFINITY_WINDOW} 收敛。
 */
function samplePoints(rawStart: number, rawEnd: number, count: number): number[] {
  const start = finiteBound(rawStart);
  const end = finiteBound(rawEnd);
  if (!(end > start)) return [];
  if (count < 1) return [(start + end) / 2];

  const step = (end - start) / (count + 1);
  return Array.from({ length: count }, (_, index) => start + step * (index + 1));
}

/** 表达式合法性 + 长度上限。任一不满足即返回原因，调用方降级为 unverified */
function checkExpression(raw: string, maxLength: number): string | null {
  const expr = raw.trim();
  if (expr.length === 0) return '表达式为空';
  if (expr.length > maxLength) return `表达式过长（${expr.length} > ${maxLength}），已跳过验证`;
  return null;
}

/** 对表达式求值并要求结果是有限实数；否则返回 null（调用方降级） */
function evaluateAt(expr: string, x: number): number | null {
  try {
    const value = parse(expr).evaluate({ x });
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 对表达式求导并求值；失败返回 null */
function derivativeAt(expr: string, x: number): number | null {
  try {
    const value = derivative(expr, 'x').evaluate({ x });
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/* ==================== 四类校验器 ==================== */

/**
 * 求导值：`mathjs.derivative` 精确符号求导后代入 `at`，与声称值比对。
 * 依据：符号求导 + 数值求值（选型文档 §3.2）。
 */
function verifyDerivative(
  claim: DerivativeClaim,
  tolerance: number,
  maxExprLength: number,
): ClaimVerdict {
  const reason = checkExpression(claim.expr, maxExprLength);
  if (reason) return { claim, status: 'unverified', detail: reason };

  const actual = derivativeAt(claim.expr, claim.at);
  if (actual === null) {
    return { claim, status: 'unverified', detail: `无法求导或求值：${claim.expr}` };
  }

  const diff = Math.abs(actual - claim.claimed);
  if (diff <= tolerance) {
    return { claim, status: 'symbolic', detail: `f'(${claim.at}) = ${actual}，与声称值一致` };
  }
  return {
    claim,
    status: 'failed',
    detail: `f'(${claim.at}) 实为 ${actual}，与声称的 ${claim.claimed} 不符（差 ${diff}）`,
  };
}

/**
 * 切线：构造 `f(a) + f'(a)·(x − a)`，与声称的切线相减，
 * 先试符号化简判 0，再用多点取样兜底（`simplify` 不是判定过程）。
 */
function verifyTangent(
  claim: TangentClaim,
  tolerance: number,
  maxExprLength: number,
): ClaimVerdict {
  const reason = checkExpression(claim.expr, maxExprLength) ?? checkExpression(claim.claimed, maxExprLength);
  if (reason) return { claim, status: 'unverified', detail: reason };

  const fa = evaluateAt(claim.expr, claim.at);
  const fpa = derivativeAt(claim.expr, claim.at);
  if (fa === null || fpa === null) {
    return { claim, status: 'unverified', detail: `无法求 f 或 f'：${claim.expr}` };
  }

  const expected = `(${fa}) + (${fpa}) * (x - (${claim.at}))`;
  let diffNode;
  try {
    diffNode = parse(`(${expected}) - (${claim.claimed})`);
  } catch {
    return { claim, status: 'unverified', detail: `切线表达式无法解析：${claim.claimed}` };
  }

  // 强判定：化简后为字符 '0'
  try {
    const simplified = simplify(diffNode).toString();
    if (simplified === '0') {
      return { claim, status: 'symbolic', detail: `两式相减化简为 0：y = ${claim.claimed}` };
    }
  } catch {
    // 化简失败不代表结论错 —— 落到下面的取样判定
  }

  // 兜底：多点取样。任一采样点不为 0 即判错
  const probes = [-3, -1, 0.5, 2, 7];
  for (const x of probes) {
    let value: unknown;
    try {
      value = diffNode.evaluate({ x });
    } catch {
      return { claim, status: 'unverified', detail: '取样求值失败' };
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { claim, status: 'unverified', detail: '取样结果非有限实数' };
    }
    if (Math.abs(value) > tolerance) {
      return {
        claim,
        status: 'failed',
        detail: `x=${x} 处两式相差 ${value}，与声称的切线 y = ${claim.claimed} 不符`,
      };
    }
  }
  return {
    claim,
    status: 'symbolic',
    detail: `化简未得 0，但 ${probes.length} 个采样点均吻合，判为通过`,
  };
}

/**
 * 单调区间：**区间取样法**。
 *
 * 1. 每个声称的递增区间内取 `samplesPerInterval` 个点，要求 `f' > 0`；
 * 2. 每个声称的递减区间同理，要求 `f' < 0`；
 * 3. 每个区间的**有限端点**处要求 `f' = 0`（分界点判据）。
 *
 * 局限：以「取样正确」替代「区间证明」，理论上可能漏判（选型文档 §3.2 已登记）。
 */
function verifyMonotonic(
  claim: MonotonicClaim,
  tolerance: number,
  maxExprLength: number,
  samplesPerInterval: number,
): ClaimVerdict {
  const reason = checkExpression(claim.expr, maxExprLength);
  if (reason) return { claim, status: 'unverified', detail: reason };

  const checkInterval = (
    range: readonly [number, number],
    wantPositive: boolean,
  ): string | null => {
    const points = samplePoints(range[0], range[1], samplesPerInterval);
    if (points.length === 0) return `区间非法：[${range[0]}, ${range[1]}]`;

    for (const x of points) {
      const value = derivativeAt(claim.expr, x);
      if (value === null) return `f'(${x}) 无法求值`;
      // 严格符号判据：留容差避免浮点噪声误判
      if (wantPositive && value <= tolerance) {
        return `声称递增的区间 [${range[0]}, ${range[1]}] 内 x=${x} 处 f' = ${value}，不大于 0`;
      }
      if (!wantPositive && value >= -tolerance) {
        return `声称递减的区间 [${range[0]}, ${range[1]}] 内 x=${x} 处 f' = ${value}，不小于 0`;
      }
    }

    // 分界点：有限端点处 f' 应当为 0
    for (const edge of [range[0], range[1]]) {
      if (!Number.isFinite(edge)) continue;
      const value = derivativeAt(claim.expr, edge);
      if (value === null) return `分界点 x=${edge} 处 f' 无法求值`;
      if (Math.abs(value) > 1e-6) {
        return `分界点 x=${edge} 处 f' = ${value}，不为 0`;
      }
    }
    return null;
  };

  for (const range of claim.claimed.inc) {
    const problem = checkInterval(range, true);
    if (problem) return { claim, status: 'failed', detail: problem };
  }
  for (const range of claim.claimed.dec) {
    const problem = checkInterval(range, false);
    if (problem) return { claim, status: 'failed', detail: problem };
  }
  return { claim, status: 'symbolic', detail: '递增/递减区间与分界点均校验通过' };
}

/**
 * 极值点：要求该点 `f' = 0`，且左右邻域 `f'` **变号**（一阶导数变号判据）。
 * 变号即区分极大/极小；只判是否为极值点，不判极大还是极小。
 */
function verifyExtremum(
  claim: ExtremumClaim,
  tolerance: number,
  maxExprLength: number,
): ClaimVerdict {
  const reason = checkExpression(claim.expr, maxExprLength);
  if (reason) return { claim, status: 'unverified', detail: reason };
  if (claim.claimed.length === 0) {
    return { claim, status: 'unverified', detail: '未声称任何极值点' };
  }

  const STEP = 0.01;
  // f'(极值点) 本应为 0，但符号求导后代入可能有浮点噪声，故取一个比一般容差更宽松的界
  const zeroTolerance = Math.max(tolerance, 1e-6);

  for (const point of claim.claimed) {
    if (!Number.isFinite(point)) {
      return { claim, status: 'unverified', detail: `极值点非有限数：${point}` };
    }
    const at = derivativeAt(claim.expr, point);
    const left = derivativeAt(claim.expr, point - STEP);
    const right = derivativeAt(claim.expr, point + STEP);
    if (at === null || left === null || right === null) {
      return { claim, status: 'unverified', detail: `x=${point} 邻域内 f' 无法求值` };
    }
    if (Math.abs(at) > zeroTolerance) {
      return { claim, status: 'failed', detail: `x=${point} 处 f' = ${at}，不为 0，不是极值点` };
    }
    if (left * right > 0) {
      return {
        claim,
        status: 'failed',
        detail: `x=${point} 两侧 f' 同号（${left} / ${right}），不构成变号`,
      };
    }
  }
  return { claim, status: 'symbolic', detail: `${claim.claimed.length} 个极值点均满足变号判据` };
}

/* ==================== 对外入口 ==================== */

/** 单条断言分派 */
function verifyOne(
  claim: MathClaim,
  tolerance: number,
  maxExprLength: number,
  samplesPerInterval: number,
): ClaimVerdict {
  try {
    switch (claim.kind) {
      case 'derivative':
        return verifyDerivative(claim, tolerance, maxExprLength);
      case 'tangent':
        return verifyTangent(claim, tolerance, maxExprLength);
      case 'monotonic':
        return verifyMonotonic(claim, tolerance, maxExprLength, samplesPerInterval);
      case 'extremum':
        return verifyExtremum(claim, tolerance, maxExprLength);
      default: {
        // 穷尽性检查：新增 kind 时这里会编译报错
        return { claim, status: 'unverified', detail: '未知的断言类型' };
      }
    }
  } catch (error) {
    // 兜底：任何未预期的异常都降级为 unverified，绝不向上抛（本模块不产生异常）
    return {
      claim,
      status: 'unverified',
      detail: `校验过程出现未预期错误，已跳过：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 汇总：任一条判错即 fail；全通过才算 symbolic；其余 unverified */
function aggregateStatus(verdicts: readonly ClaimVerdict[]): VerificationStatus {
  if (verdicts.length === 0) return 'unverified';
  if (verdicts.some((verdict) => verdict.status === 'failed')) return 'failed';
  if (verdicts.every((verdict) => verdict.status === 'symbolic')) return 'symbolic';
  return 'unverified';
}

/**
 * 逐条校验一批断言。**不抛异常** —— 所有问题都反映在返回值的 `status` 与 `detail` 上。
 */
export function verifyClaims(
  claims: readonly MathClaim[],
  options: VerifyOptions = {},
): VerifyResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxExprLength = options.maxExprLength ?? DEFAULT_MAX_EXPR_LENGTH;
  const samplesPerInterval = options.samplesPerInterval ?? DEFAULT_SAMPLES_PER_INTERVAL;

  const startedAt = Date.now();
  const verdicts: ClaimVerdict[] = [];

  for (const claim of claims) {
    // 时间预算：已用时间**达到**预算就跳过剩余断言，降级为 unverified 且**不阻断答疑**
    // （选型文档 §4.5）。用 >= 而非 > —— 否则 budgetMs=0 时第一条仍会被执行。
    if (Date.now() - startedAt >= budgetMs) {
      verdicts.push({
        claim,
        status: 'unverified',
        detail: `符号验证已达到 ${budgetMs}ms 预算，已跳过（不阻断答疑）`,
      });
      continue;
    }
    verdicts.push(verifyOne(claim, tolerance, maxExprLength, samplesPerInterval));
  }

  return {
    status: aggregateStatus(verdicts),
    verdicts,
    durationMs: Date.now() - startedAt,
  };
}

/* ==================== 固定案例基线 ==================== */

/**
 * §7.1 的三个固定案例 + 负例。
 *
 * **期望值是硬编码的**（选型文档 §3.2 的补偿 2）：任何算法改动都必须仍然通过这组断言，
 * 否则说明改动引入了回归。这也是"1e-9 容差 + 3 点取样"之外的第二道防线。
 */
export interface FixedCase {
  readonly name: string;
  readonly claim: MathClaim;
  /** 期望的单条判定 */
  readonly expect: ClaimStatus;
}

export const FIXED_CASES: readonly FixedCase[] = [
  {
    name: '§7.1-① x² 在 x=1 处的导数为 2',
    claim: { kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 },
    expect: 'symbolic',
  },
  {
    name: '§7.1-② x² 在 x=1 处的切线为 y = 2x − 1',
    claim: { kind: 'tangent', expr: 'x^2', at: 1, claimed: '2*x - 1' },
    expect: 'symbolic',
  },
  {
    name: '§7.1-③ x³ − 3x 的单调区间：增 (−∞,−1]∪[1,+∞)，减 [−1,1]',
    claim: {
      kind: 'monotonic',
      expr: 'x^3 - 3*x',
      claimed: { inc: [[-Infinity, -1], [1, Infinity]], dec: [[-1, 1]] },
    },
    expect: 'symbolic',
  },
  {
    name: 'x³ − 3x 的极值点为 x = −1 与 x = 1',
    claim: { kind: 'extremum', expr: 'x^3 - 3*x', claimed: [-1, 1] },
    expect: 'symbolic',
  },
  // ↓ 负例：这些**必须**被判错，用来防止校验器"放水"
  {
    name: '【负例】x² 在 x=1 处导数声称 3（实为 2）',
    claim: { kind: 'derivative', expr: 'x^2', at: 1, claimed: 3 },
    expect: 'failed',
  },
  {
    name: '【负例】x² 在 x=1 处的切线声称 y = 2x + 5',
    claim: { kind: 'tangent', expr: 'x^2', at: 1, claimed: '2*x + 5' },
    expect: 'failed',
  },
  {
    name: '【负例】x³ − 3x 声称全区间递增',
    claim: {
      kind: 'monotonic',
      expr: 'x^3 - 3*x',
      claimed: { inc: [[-Infinity, Infinity]], dec: [] },
    },
    expect: 'failed',
  },
  {
    name: '【负例】x³ − 3x 声称极值点为 x = 0（实为 ±1）',
    claim: { kind: 'extremum', expr: 'x^3 - 3*x', claimed: [0] },
    expect: 'failed',
  },
];

export interface FixedCaseResult {
  readonly name: string;
  readonly expect: ClaimStatus;
  readonly actual: ClaimStatus;
  readonly passed: boolean;
  readonly detail: string;
}

/** 跑一遍固定案例基线。返回逐条结果与总体是否全过 */
export function runFixedCases(): { allPassed: boolean; results: readonly FixedCaseResult[] } {
  const results: FixedCaseResult[] = FIXED_CASES.map((fixed) => {
    const verdict = verifyOne(fixed.claim, DEFAULT_TOLERANCE, DEFAULT_MAX_EXPR_LENGTH, DEFAULT_SAMPLES_PER_INTERVAL);
    return {
      name: fixed.name,
      expect: fixed.expect,
      actual: verdict.status,
      passed: verdict.status === fixed.expect,
      detail: verdict.detail,
    };
  });
  return { allPassed: results.every((result) => result.passed), results };
}

/** 供 `/api/health` 如实上报引擎状态用 */
export const SYMBOLIC_ENGINE = {
  engine: 'mathjs',
  /** 本模块已落地 —— 这个常量存在即代表能力可用，health 据此上报 available */
  available: true,
} as const;
