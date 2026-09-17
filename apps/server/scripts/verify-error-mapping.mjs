/**
 * 模型错误映射 + 请求预算 + 受控重试 的验证脚本
 *
 * 对应说明书 V1.4 第 9.3 节：
 *   「错误层未完整映射模型错误」→ C 负责统一映射认证、额度、超时与上游错误；
 *   「保留单次业务请求 60 秒总预算；重试计入同一预算」。
 *
 * 全部为纯函数 / 假调用函数验证，**不发起网络请求、不消耗任何额度、不需要密钥**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:errors
 */

import { ModelError } from '../src/model/errors.js';
import {
  MAX_RETRIES,
  MIN_RETRY_REMAINING_MS,
  canRetry,
  createBudget,
  remainingMs,
  withBudget,
} from '../src/model/budget.js';
import { mapModelError } from '../src/http/model-error-map.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 静默 logger：避免测试输出被调用日志淹没 */
const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * 假模型调用函数。
 * `script` 是依次返回的结果；元素为 Error 时抛出，为字符串时返回。
 * 最后一个元素会被重复使用（用于"一直失败"的场景）。
 */
function fakeCaller(script) {
  const calls = [];
  const call = async (input, options) => {
    calls.push({ input, timeoutMs: options?.timeoutMs });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { call, calls };
}

console.log('=== 模型错误映射 / 请求预算 / 受控重试 验证 ===\n');

/* ==================== 1. 错误映射表 ==================== */
console.log('1. 错误映射表（说明书 V1.4：统一映射认证、额度、超时与上游）');
{
  const cases = [
    ['AUTH', 401, 'MODEL_ERROR', false],
    ['QUOTA', 429, 'MODEL_ERROR', false],
    ['TIMEOUT', 504, 'MODEL_TIMEOUT', true],
    ['UPSTREAM', 502, 'MODEL_ERROR', true],
    ['INVALID_REQUEST', 400, 'MODEL_ERROR', false],
  ];
  for (const [code, status, apiCode, retryable] of cases) {
    const m = mapModelError(code);
    check(
      `${code} → ${status} / ${apiCode} / retryable=${retryable}`,
      m.status === status && m.code === apiCode && m.retryable === retryable,
      `实际 ${m.status} / ${m.code} / ${m.retryable}`,
    );
  }
  check('超时必须可重试（说明书 5.3：可重试并保留输入）', mapModelError('TIMEOUT').retryable === true);
  check('认证必须不可重试（重试无用）', mapModelError('AUTH').retryable === false);
}

/* ==================== 2. 预算计算 ==================== */
console.log('\n2. 预算计算');
{
  const t0 = 1_000_000;
  const budget = createBudget(60_000, t0);

  check('初始剩余 = 总量', remainingMs(budget, t0) === 60_000);
  check('10 秒后剩余 = 50 秒', remainingMs(budget, t0 + 10_000) === 50_000);
  check('耗尽时为 0', remainingMs(budget, t0 + 60_000) === 0);
  check('★ 超时后不为负', remainingMs(budget, t0 + 99_999) === 0, `实际 ${remainingMs(budget, t0 + 99_999)}`);
  check('初始 attempts 为 0', budget.attempts === 0);
}

/* ==================== 3. 重试判定 ==================== */
console.log('\n3. canRetry 判定');
{
  const fresh = () => {
    const b = createBudget(60_000, 1_000_000);
    b.attempts = 1; // 模拟"已发起过第一次调用"
    return b;
  };

  check('UPSTREAM + 剩余充足 → 可重试', canRetry(new ModelError('UPSTREAM', 'x'), fresh(), 1_010_000));
  check('AUTH → 不可重试', !canRetry(new ModelError('AUTH', 'x'), fresh(), 1_010_000));
  check('QUOTA → 不可重试', !canRetry(new ModelError('QUOTA', 'x'), fresh(), 1_010_000));
  check('TIMEOUT → 不可重试', !canRetry(new ModelError('TIMEOUT', 'x'), fresh(), 1_010_000));
  check('INVALID_REQUEST → 不可重试', !canRetry(new ModelError('INVALID_REQUEST', 'x'), fresh(), 1_010_000));
  check('非 ModelError → 不可重试', !canRetry(new Error('普通错误'), fresh(), 1_010_000));

  const used = fresh();
  used.attempts = MAX_RETRIES + 1;
  check(`重试次数已用完（attempts=${MAX_RETRIES + 1}）→ 不可重试`, !canRetry(new ModelError('UPSTREAM', 'x'), used, 1_010_000));

  const tight = fresh();
  check(
    `剩余 < ${MIN_RETRY_REMAINING_MS}ms → 不可重试`,
    !canRetry(new ModelError('UPSTREAM', 'x'), tight, 1_000_000 + 60_000 - 1_000),
  );
}

/* ==================== 4. withBudget 行为 ==================== */
console.log('\n4. withBudget 行为');

// 4.1 成功一次
{
  const b = createBudget(60_000);
  const { call, calls } = fakeCaller(['答案A']);
  const wrapped = withBudget(call, b, silentLogger);
  const text = await wrapped('问题');
  check('成功：返回模型文本', text === '答案A', String(text));
  check('成功：只调用 1 次', calls.length === 1, `实际 ${calls.length}`);
  check('成功：传入了超时时间', typeof calls[0].timeoutMs === 'number' && calls[0].timeoutMs > 0, String(calls[0].timeoutMs));
}

// 4.2 UPSTREAM 失败一次后成功 → 应该重试
{
  const b = createBudget(60_000);
  const { call, calls } = fakeCaller([new ModelError('UPSTREAM', '上游 503'), '答案B']);
  const wrapped = withBudget(call, b, silentLogger);
  const text = await wrapped('问题');
  check('★ UPSTREAM 失败后重试并成功', text === '答案B', String(text));
  check('★ 共调用 2 次（1 次 + 1 次重试）', calls.length === 2, `实际 ${calls.length}`);
}

// 4.3 UPSTREAM 一直失败 → 重试次数用尽后抛出
{
  const b = createBudget(60_000);
  const { call, calls } = fakeCaller([new ModelError('UPSTREAM', '上游 503')]);
  const wrapped = withBudget(call, b, silentLogger);
  let threw = null;
  try {
    await wrapped('问题');
  } catch (error) {
    threw = error;
  }
  check('★ 一直失败时最终抛出 ModelError', threw instanceof ModelError, threw ? String(threw) : '未抛出');
  check(`★ 调用次数被限制为 ${MAX_RETRIES + 1} 次`, calls.length === MAX_RETRIES + 1, `实际 ${calls.length}`);
}

// 4.4 AUTH 失败 → 不重试
{
  const b = createBudget(60_000);
  const { call, calls } = fakeCaller([new ModelError('AUTH', '凭证无效')]);
  const wrapped = withBudget(call, b, silentLogger);
  let threw = null;
  try {
    await wrapped('问题');
  } catch (error) {
    threw = error;
  }
  check('★ AUTH 失败不重试（调用 1 次）', calls.length === 1, `实际 ${calls.length}`);
  check('AUTH 错误原样抛出', threw instanceof ModelError && threw.code === 'AUTH');
}

// 4.5 剩余预算不足 → 不重试
{
  const b = createBudget(3_000); // 3 秒 < MIN_RETRY_REMAINING_MS
  const { call, calls } = fakeCaller([new ModelError('UPSTREAM', '上游 503')]);
  const wrapped = withBudget(call, b, silentLogger);
  try {
    await wrapped('问题');
  } catch {
    /* 预期抛出 */
  }
  check(
    `★ 剩余不足 ${MIN_RETRY_REMAINING_MS}ms 时不重试（调用 1 次）`,
    calls.length === 1,
    `实际 ${calls.length}`,
  );
}

// 4.6 预算已耗尽 → 不发起任何调用
{
  const b = createBudget(0, Date.now() - 1_000);
  const { call, calls } = fakeCaller(['不该被调用']);
  const wrapped = withBudget(call, b, silentLogger);
  let threw = null;
  try {
    await wrapped('问题');
  } catch (error) {
    threw = error;
  }
  check('★ 预算耗尽时不发起调用', calls.length === 0, `实际 ${calls.length}`);
  check('预算耗尽时抛 TIMEOUT', threw instanceof ModelError && threw.code === 'TIMEOUT', threw ? String(threw) : '未抛出');
}

// 4.7 调用方指定的超时也要受总预算约束
{
  const b = createBudget(8_000);
  const { call, calls } = fakeCaller(['答案C']);
  const wrapped = withBudget(call, b, silentLogger);
  await wrapped('问题', { timeoutMs: 999_999 });
  check(
    '★ 调用方传入的超时被总预算截断',
    calls[0].timeoutMs <= 8_000,
    `实际传入 ${calls[0].timeoutMs}`,
  );
}

// 4.8 输入原样透传（字符串与图文块都支持）
{
  const b = createBudget(60_000);
  const { call, calls } = fakeCaller(['答案D']);
  const wrapped = withBudget(call, b, silentLogger);
  const blocks = [
    { type: 'text', text: '看这张图' },
    { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
  ];
  await wrapped(blocks);
  check('图文块输入原样透传', calls[0].input === blocks);
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
