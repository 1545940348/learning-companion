/**
 * 错误响应与入参守卫的回归验证
 *
 * 对应本轮修复（`docs/plans/2026-09-17-C-PR2收口与错误层自洽.md`）：
 * 1. 同一个契约错误码必须在所有路径上给出**相同**的状态码与 `retryable`；
 * 2. `INTERNAL` 不得被标成可重试，也不得回显内部报错原文；
 * 3. 请求体解析失败属客户端问题，应为 400 而不是 500；
 * 4. 入参形状不合法一律 400，且文案说清哪个字段不对。
 *
 * 全部为纯函数 / 假 res 驱动，**不启动服务、不发网络请求、不需要密钥**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:guards
 */

import {
  classifyBodyError,
  defaultStatusForApiCode,
  isRetryableApiCode,
} from '../src/http/error-response.js';
import {
  guardMaterialVersion,
  guardMaterials,
  guardMode,
  guardNullableSessionId,
  guardNonEmptyText,
  guardOptionalText,
  guardQuestion,
  guardQuizSource,
  guardRecentAnswers,
  guardSessionId,
  guardTopic,
} from '../src/http/request-guards.js';
import { ApiError, errorHandler } from '../src/http/routes.js';
import { ModelError } from '../src/model/errors.js';
import { SessionNotFoundError, SessionVersionConflictError } from '../src/store/index.js';
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

/** 假 res：只实现 errorHandler 用到的三个成员 */
function fakeRes() {
  const state = { headersSent: false, status: 0, body: null };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    status(code) {
      state.status = code;
      return res;
    },
    json(body) {
      state.body = body;
      return res;
    },
    /** 供断言使用 */
    _state: state,
  };
  return res;
}

/** 驱动 errorHandler，返回实际发出的响应 */
function runHandler(error) {
  const res = fakeRes();
  errorHandler(error, {}, res, () => {});
  return { status: res._state.status, error: res._state.body?.error };
}

/* ==================== 1. 错误码 → 状态码 / retryable 矩阵 ==================== */
console.log('1. 契约错误码矩阵（同一张表推导，不在分支里写死）');
{
  const expected = [
    ['BAD_REQUEST', 400, false],
    ['UNAUTHORIZED_CONTENT', 403, false],
    ['NOT_FOUND', 404, false],
    ['SESSION_STALE', 409, true],
    ['MODEL_ERROR', 502, false],
    ['MODEL_TIMEOUT', 504, true],
    ['INTERNAL', 500, false],
  ];
  for (const [code, status, retryable] of expected) {
    check(
      `${code} → ${status} / retryable=${retryable}`,
      defaultStatusForApiCode(code) === status && isRetryableApiCode(code) === retryable,
      `实际 ${defaultStatusForApiCode(code)} / ${isRetryableApiCode(code)}`,
    );
  }
}

/* ==================== 2. 每个 ApiErrorCode 经 errorHandler 都自洽 ==================== */
console.log('\n2. ApiError 经 errorHandler 的响应与码表一致');
{
  const codes = [
    'BAD_REQUEST',
    'UNAUTHORIZED_CONTENT',
    'NOT_FOUND',
    'SESSION_STALE',
    'MODEL_ERROR',
    'MODEL_TIMEOUT',
    'INTERNAL',
  ];
  for (const code of codes) {
    const res = runHandler(new ApiError(code, '测试消息'));
    check(
      `${code}：状态码 = ${defaultStatusForApiCode(code)}、retryable = ${isRetryableApiCode(code)}`,
      res.status === defaultStatusForApiCode(code) &&
        res.error.retryable === isRetryableApiCode(code),
      `实际 ${res.status} / ${res.error.retryable}`,
    );
  }
}

/* ==================== 3. SESSION_STALE 两条路径必须完全一致（本轮核心修复） ==================== */
console.log('\n3. SESSION_STALE：入口校验与提交复核必须给出同一个答案');
{
  const atEntry = runHandler(new ApiError('SESSION_STALE', '入口版本校验'));
  const atCommit = runHandler(new SessionVersionConflictError('s-1', 0, 1));
  check('入口：409', atEntry.status === 409, String(atEntry.status));
  check('入口：retryable=true', atEntry.error.retryable === true, String(atEntry.error.retryable));
  check('提交复核：409', atCommit.status === 409, String(atCommit.status));
  check(
    '提交复核：retryable=true',
    atCommit.error.retryable === true,
    String(atCommit.error.retryable),
  );
  check(
    '★ 两条路径状态码一致',
    atEntry.status === atCommit.status,
    `${atEntry.status} vs ${atCommit.status}`,
  );
  check(
    '★ 两条路径 retryable 一致',
    atEntry.error.retryable === atCommit.error.retryable,
    `${atEntry.error.retryable} vs ${atCommit.error.retryable}`,
  );
  check(
    '★ 两条路径错误码一致',
    atEntry.error.code === atCommit.error.code,
    `${atEntry.error.code} vs ${atCommit.error.code}`,
  );
}

/* ==================== 4. 模型错误 5 分类仍然成立（更细的码说了算） ==================== */
console.log('\n4. 模型错误映射未被回退');
{
  const expected = [
    ['AUTH', 401, false],
    ['QUOTA', 429, false],
    ['TIMEOUT', 504, true],
    ['UPSTREAM', 502, true],
    ['INVALID_REQUEST', 400, false],
  ];
  for (const [code, status, retryable] of expected) {
    const res = runHandler(new ModelError(code, 'x'));
    check(
      `${code} → ${status} / retryable=${retryable}`,
      res.status === status && res.error.retryable === retryable,
      `实际 ${res.status} / ${res.error.retryable}`,
    );
    check(
      `${code}：与 model-error-map 表一致`,
      res.status === mapModelError(code).status &&
        res.error.retryable === mapModelError(code).retryable,
    );
  }
  check('★ UPSTREAM 仍可重试（比 MODEL_ERROR 更细的码说了算）', runHandler(new ModelError('UPSTREAM', 'x')).error.retryable === true);
}

/* ==================== 5. 请求体解析失败 → 400，不回显解析器原文 ==================== */
console.log('\n5. 请求体解析失败');
{
  const parseError = Object.assign(new SyntaxError("Expected property name or '}' in JSON at position 1 (line 1 column 2)"), {
    status: 400,
    type: 'entity.parse.failed',
  });
  const res = runHandler(parseError);
  check('★ 畸形 JSON → 400（原来会 500）', res.status === 400, String(res.status));
  check('★ 错误码为 BAD_REQUEST', res.error.code === 'BAD_REQUEST', res.error.code);
  check('★ 不可重试', res.error.retryable === false, String(res.error.retryable));
  check(
    '★ 不回显解析器原文',
    !res.error.message.includes('position') && !res.error.message.includes('Expected'),
    res.error.message,
  );

  const tooLarge = Object.assign(new Error('request entity too large'), {
    status: 413,
    type: 'entity.too.large',
  });
  const big = runHandler(tooLarge);
  check('超大请求体 → 413 且不可重试', big.status === 413 && big.error.retryable === false, `${big.status}`);

  check('非 body 解析类错误不被误判', classifyBodyError(new Error('普通错误')) === null);
}

/* ==================== 6. INTERNAL 不可重试且不泄露内部报错 ==================== */
console.log('\n6. 未分类内部错误');
{
  const res = runHandler(new TypeError("Cannot read properties of undefined (reading 'length')"));
  check('状态码 500', res.status === 500, String(res.status));
  check('错误码 INTERNAL', res.error.code === 'INTERNAL', res.error.code);
  check('★ INTERNAL 不可重试（原来标成可重试）', res.error.retryable === false, String(res.error.retryable));
  check(
    '★ 不回显内部报错原文',
    !res.error.message.includes('Cannot read') && !res.error.message.includes('undefined'),
    res.error.message,
  );
}

/* ==================== 7. 超时兜底文案跟随配置 ==================== */
console.log('\n7. 超时兜底');
{
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const res = runHandler(abort);
  check('AbortError → 504 MODEL_TIMEOUT 可重试', res.status === 504 && res.error.code === 'MODEL_TIMEOUT' && res.error.retryable === true, `${res.status}/${res.error.code}`);
  check('★ 文案含实际配置秒数而非写死 60', /\d+ 秒/.test(res.error.message), res.error.message);
}

/* ==================== 8. 会话不存在的映射未变 ==================== */
console.log('\n8. 会话不存在');
{
  const res = runHandler(new SessionNotFoundError('s-x'));
  check('404 / NOT_FOUND / 不可重试', res.status === 404 && res.error.code === 'NOT_FOUND' && res.error.retryable === false, `${res.status}/${res.error.code}`);
}

/* ==================== 9. 入参守卫 ==================== */
console.log('\n9. 入参守卫（形状不合法一律 400，不再落到 500）');
{
  // sessionId
  check('sessionId 缺省 → 拒绝', guardSessionId(undefined).ok === false);
  check('sessionId 空串 → 拒绝', guardSessionId('   ').ok === false);
  check('sessionId 正常 → 通过', guardSessionId(' s-1 ').ok && guardSessionId(' s-1 ').value === 's-1');

  // 可为空会话（/tutor 轻路径）
  check('sessionId=null → 轻路径', guardNullableSessionId(null).ok && guardNullableSessionId(null).value === null);
  check('sessionId 空串 → 轻路径', guardNullableSessionId('').ok && guardNullableSessionId('').value === null);
  check('★ sessionId 省略 → 明确拒绝（不再被下游当成越权）', guardNullableSessionId(undefined).ok === false);
  check('sessionId 非法类型 → 拒绝', guardNullableSessionId(42).ok === false);

  // 材料
  check('materials 缺省 → 空数组', guardMaterials(undefined).ok && guardMaterials(undefined).value.length === 0);
  check('★ materials 是字符串 → 拒绝（原来 500）', guardMaterials('abc').ok === false, JSON.stringify(guardMaterials('abc')));
  check('★ materials 元素缺 text → 拒绝（原来 500）', guardMaterials([{ id: 'x' }]).ok === false);
  check('materials 元素不是对象 → 拒绝', guardMaterials(['x']).ok === false);
  check('materials 元素缺 id → 拒绝', guardMaterials([{ text: 'x' }]).ok === false);
  check('kind 非法取值 → 拒绝', guardMaterials([{ id: 'a', text: 'x', kind: 'nope' }]).ok === false);
  const good = guardMaterials([{ id: 'a', text: '导数与单调性', kind: 'upload' }]);
  check('合法材料 → 通过', good.ok === true);
  check('createdAt 缺省由服务端补齐', good.ok && typeof good.value[0].createdAt === 'string');
  check('kind 缺省为 upload', good.ok && good.value[0].kind === 'upload');

  // 版本
  check('version=0 → 通过', guardMaterialVersion(0).ok && guardMaterialVersion(0).value === 0);
  check('version 缺省 → 拒绝', guardMaterialVersion(undefined).ok === false);
  check('version 为字符串 → 拒绝', guardMaterialVersion('1').ok === false);
  check('version 为小数 → 拒绝', guardMaterialVersion(1.5).ok === false);
  check('version 为负数 → 拒绝', guardMaterialVersion(-1).ok === false);

  // 答疑
  check('question 空白 → 拒绝', guardQuestion('   ').ok === false);
  check('mode 缺省 → explain', guardMode(undefined).ok && guardMode(undefined).value === 'explain');
  check('mode 非法 → 拒绝', guardMode('nope').ok === false);
  check('mode=hint → 通过', guardMode('hint').ok && guardMode('hint').value === 'hint');
  check('knowledgePointId 缺省 → undefined', guardOptionalText(undefined, 'k').ok && guardOptionalText(undefined, 'k').value === undefined);
  check('recentAnswers 缺省 → undefined', guardRecentAnswers(undefined).ok);
  check('recentAnswers 非数组 → 拒绝', guardRecentAnswers('x').ok === false);
  check('recentAnswers 元素缺字段 → 拒绝', guardRecentAnswers([{}]).ok === false);
  check('recentAnswers 合法 → 通过', guardRecentAnswers([{ question: 'q', answer: 'a' }]).ok === true);

  // 练习
  check('topic=monotonicity → 通过', guardTopic('monotonicity').ok === true);
  check('★ topic 非法 → 拒绝（原来返回 200 空题集）', guardTopic('nope').ok === false);
  check('topic 为数组 → 拒绝', guardTopic(['a']).ok === false);
  check('source 缺省 → fixed', guardQuizSource(undefined).ok && guardQuizSource(undefined).value === 'fixed');
  check('source 非法 → 拒绝', guardQuizSource('nope').ok === false);

  // 非空文本
  check('conceptId 空白 → 拒绝', guardNonEmptyText('  ', 'conceptId').ok === false);
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
