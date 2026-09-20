/**
 * 符号验证引擎（`B3`）验证脚本
 *
 * 对应说明书 V2.0 §4.4、选型文档 `docs/tech/2026-09-17-符号验证引擎选型-纯TS.md`、
 * 说明书 §7.1 的三个固定案例（与 `P-B16` 要求"实现与回归共用同一份期望值"）。
 *
 * ### 这个脚本要证明的四件事
 *
 * 1. **有分辨力**：固定案例表里既有**正例**也有**负例**与**越界例**
 *    —— 一个"永远返回 verified"的实现过不了负例，一个"永远返回 unverified"的实现过不了正例。
 *    （本项目吃过"恒真断言"的亏，见 `I24`。）
 * 2. **白名单真的在拦**：`mathjs` 的 `derivative()` 对垃圾输入**静默返回 0**
 *    （实测 `derivative('not-an-expr','x')` → `0`），所以"表达式没被理解"会伪装成合理结论。
 * 3. **提示词与契约常量没漂移**：`SYSTEM_GAP` 里写死的 200—400 必须等于 `SUPPLEMENT_LENGTH`。
 * 4. **`I18` 的一致性断言真的会拒绝**：验证状态不达标时不得写成 `VERIFIED`。
 *
 * 全部为纯函数 / 内存 store 调用，**不消耗模型额度**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:symbolic
 */

import {
  FIXED_CASES,
  SYSTEM_GAP,
  countSupplementCharacters,
  latexToExpression,
  runFixedCases,
  verifyClaims,
  verifySupplementContent,
} from '@lc/teaching';
import { SUPPLEMENT_LENGTH } from '@lc/contracts';
import { createMockAdapter } from '../src/model/index.js';
import {
  clearSessions,
  commitSupplement,
  createSession,
} from '../src/store/index.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail === undefined ? '' : ` —— ${JSON.stringify(detail)}`}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/* ==================== 1. 固定案例基线（P-B16，与实现共用同一份表） ==================== */

section(`1. 固定案例基线：${FIXED_CASES.length} 例（含负例与越界例）`);

{
  const outcomes = runFixedCases();
  for (const outcome of outcomes) {
    check(
      `${outcome.id} 期望 ${outcome.expect} → 实得 ${outcome.actual}（${outcome.reason.slice(0, 60)}…）`,
      outcome.passed,
      outcome,
    );
  }

  const positives = FIXED_CASES.filter((item) => item.expect === 'symbolic');
  const negatives = FIXED_CASES.filter((item) => item.expect === 'failed');
  const outOfScope = FIXED_CASES.filter((item) => item.expect === 'unverified');
  check(
    '★ 表里有正例、负例、越界例三类（只有正例证明不了分辨力）',
    positives.length >= 3 && negatives.length >= 2 && outOfScope.length >= 2,
    { positives: positives.length, negatives: negatives.length, outOfScope: outOfScope.length },
  );
}

/* ==================== 2. 汇总口径：从严 ==================== */

section('2. 汇总口径：没有断言 ≠ 通过；任一条不过则整体不过');

{
  check(
    '★ 空 claims → unverified（"没有断言"不等于"通过"）',
    verifyClaims([]).status === 'unverified',
    verifyClaims([]).status,
  );
  check('claims 不是数组 → unverified', verifyClaims(null).status === 'unverified');
  check(
    'claims 条数超限 → 整体 unverified（输入规模上限，非 Promise.race）',
    verifyClaims(new Array(20).fill({ kind: 'derivative', expr: 'x', at: 1, claimed: 1 })).status ===
      'unverified',
  );

  const mixed = verifyClaims([
    { kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 }, // 过
    { kind: 'derivative', expr: 'x^2', at: 1, claimed: 3 }, // 不过
  ]);
  check('★ 一条过、一条不过 → 整体 failed（不因为有一半过就放过）', mixed.status === 'failed', mixed.status);

  const partlyInconclusive = verifyClaims([
    { kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 }, // 过
    { kind: 'derivative', expr: '\\sin{x}', at: 1, claimed: 1 }, // 越界
  ]);
  check(
    '★ 一条过、一条定不了 → 整体 unverified（不得因"部分通过"就说整体已验证）',
    partlyInconclusive.status === 'unverified',
    partlyInconclusive.status,
  );
}

/* ==================== 3. 逐类判据的关键边界 ==================== */

section('3. 判据边界：非实数、超范围、形状非法');

{
  // sqrt 在负半轴是复数 —— 课程范围要求一元实函数，"定不了"必须如实说
  const complexValue = verifyClaims([{ kind: 'derivative', expr: 'x^0.5', at: -1, claimed: 0 }]);
  check('★ 求值为复数 → unverified（不当成通过，也不当成"错"）', complexValue.status === 'unverified', complexValue.status);
  check(
    '复数原因写清楚了',
    String(complexValue.checks[0]?.reason ?? '').includes('有限实数'),
    complexValue.checks[0]?.reason,
  );

  check(
    '`at` 不是数字 → unverified',
    verifyClaims([{ kind: 'derivative', expr: 'x^2', at: '1', claimed: 2 }]).status === 'unverified',
  );
  check('未登记的断言类型 → unverified', verifyClaims([{ kind: 'integral', expr: 'x^2' }]).status === 'unverified');
  check(
    'monotonic 的两端都无界 → unverified（取样覆盖不了整条实轴，不假装通过）',
    verifyClaims([{ kind: 'monotonic', expr: 'x^3', claimed: { inc: [[null, null]], dec: [] } }]).status ===
      'unverified',
  );
  check(
    'monotonic 区间不合法（a ≥ b）→ unverified',
    verifyClaims([{ kind: 'monotonic', expr: 'x^3', claimed: { inc: [[3, 1]], dec: [] } }]).status ===
      'unverified',
  );
  check(
    'extremum 某点不是驻点 → failed',
    verifyClaims([{ kind: 'extremum', expr: 'x^3 - 3x', claimed: [0] }]).status === 'failed',
    verifyClaims([{ kind: 'extremum', expr: 'x^3 - 3x', claimed: [0] }]).checks,
  );
  check(
    'extremum 驻点但不变号（x³ 在 0）→ failed',
    verifyClaims([{ kind: 'extremum', expr: 'x^3', claimed: [0] }]).status === 'failed',
  );
}

/* ==================== 4. LaTeX 白名单 ==================== */

section('4. LaTeX 白名单：该通的通，该拦的拦（拦的就是 mathjs 会静默给出 0 的那些）');

{
  const accepted = [
    ['x^2', 'x^2'],
    ['x^{2}', 'x^(2)'],
    ['\\frac{2}{x}', '((2)/(x))'],
    ['\\sqrt{x}', '(sqrt(x))'],
    ['2\\cdot x', '2*x'],
    ['\\left(x+1\\right)', '(x+1)'],
    ['y = x^2', 'x^2'],
    ["f'(x) = 2x", '2x'],
    ['$x^2$', 'x^2'],
  ];
  for (const [input, expected] of accepted) {
    const result = latexToExpression(input);
    check(
      `接受 ${input} → ${expected}`,
      result.ok && result.expr === expected,
      result.ok ? result.expr : result.reason,
    );
  }

  const rejected = [
    ['\\sin{x}', '三角函数不在课程范围'],
    ['\\log{x}', '对数不在课程范围'],
    ['\\sqrt[3]{x}', 'n 次根不在白名单'],
    ['\\int x', '未登记命令'],
    ['x_1', '下标变量不在课程范围'],
    ['y^2', '变量 y 不在白名单'],
    ['\\frac{a}{b}', '字母常量不在白名单'],
    ['x^2 = 4', '关系式不是表达式'],
    ['x > 0', '关系式不是表达式'],
    ['', '空表达式'],
  ];
  for (const [input, why] of rejected) {
    const result = latexToExpression(input);
    check(`拒绝 ${JSON.stringify(input)}（${why}）`, !result.ok, result.ok ? result.expr : undefined);
  }

  const parsed = latexToExpression('x^2');
  check('返回结构里带 expr 与 notes', parsed.ok && typeof parsed.expr === 'string' && Array.isArray(parsed.notes));
}

/*
 * 语法错（`1 +`、`+^`）**不由白名单层判**：它们用的都是允许的记号，
 * 是"记号合法但不成式子"。由解析层（`mathjs.parse`）拦住 → `unverified`。
 * 这条边界要写清楚，否则以后有人会以为白名单层能做语法校验。
 */
section('4b. 语法错由解析层拦住（白名单只管记号，不管语法）');

{
  for (const expression of ['1 +', 'x + 1 +^ 2', '((x+1)', 'x^']) {
    const converted = latexToExpression(expression);
    check(
      `${JSON.stringify(expression)} 能被白名单接受（记号合法）`,
      converted.ok,
      converted.ok ? undefined : converted.reason,
    );
    const report = verifyClaims([{ kind: 'derivative', expr: expression, at: 1, claimed: 1 }]);
    check(`★ ${JSON.stringify(expression)} 在解析层被拦下 → unverified`, report.status === 'unverified', report.status);
  }
}

/* ==================== 5. 补充内容的长度核对（SUPPLEMENT_LENGTH 接线，I18） ==================== */

section('5. 补充内容长度核对：SUPPLEMENT_LENGTH 已接线');

{
  const claims = [{ kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 }];
  const goodLength = '导'.repeat(300);

  const inRange = verifySupplementContent({ content: goodLength, claims });
  check('长度在 200—400 内 + 断言通过 → symbolic', inRange.status === 'symbolic', inRange.status);

  const tooLong = verifySupplementContent({ content: '导'.repeat(500), claims });
  check(
    '★ 长度超出区间 → 不据此标已验证（照常返回内容，只是不标 symbolic）',
    tooLong.status === 'unverified',
    tooLong.status,
  );
  check(
    '长度问题写进了 notes',
    tooLong.notes.some((note) => note.includes('超出目标区间')),
    tooLong.notes,
  );

  check(
    '空白不计入长度（换行与缩进不是"字"）',
    countSupplementCharacters(`${'a'.repeat(200)}${'\n '.repeat(50)}`) === 200,
    countSupplementCharacters(`${'a'.repeat(200)}${'\n '.repeat(50)}`),
  );
  check('长度区间常量来自契约', SUPPLEMENT_LENGTH.min === 200 && SUPPLEMENT_LENGTH.max === 400);
}

/* ==================== 6. 提示词与常量的一致性 ==================== */

section('6. 提示词接线：SYSTEM_GAP 里写死的长度区间必须等于契约常量');

{
  check(
    `★ SYSTEM_GAP 含 ${SUPPLEMENT_LENGTH.min}—${SUPPLEMENT_LENGTH.max}（与 SUPPLEMENT_LENGTH 一致）`,
    SYSTEM_GAP.includes(`${SUPPLEMENT_LENGTH.min}—${SUPPLEMENT_LENGTH.max}`),
  );
  check('★ SYSTEM_GAP 要求输出 JSON 与 claims（结构化断言）', SYSTEM_GAP.includes('"claims"'));
  check(
    '★ SYSTEM_GAP 写明"写不出就留空、不要编造断言"',
    SYSTEM_GAP.includes('不要为了凑数而编造断言'),
  );
}

/* ==================== 7. mock 保真：无密钥演示路径真的能到 VERIFIED ==================== */

section('7. mock 保真：演示/录屏走的那条路必须真能标 symbolic');

{
  const mock = createMockAdapter();
  const raw = await mock.call('（占位）', { system: SYSTEM_GAP, json: true });
  const parsed = JSON.parse(raw);

  check('mock 的补充通道返回可解析 JSON', typeof parsed === 'object' && parsed !== null);
  check(
    '★ mock 的 content 长度在 SUPPLEMENT_LENGTH 区间内',
    countSupplementCharacters(parsed.content) >= SUPPLEMENT_LENGTH.min &&
      countSupplementCharacters(parsed.content) <= SUPPLEMENT_LENGTH.max,
    countSupplementCharacters(parsed.content),
  );
  check('mock 带 claims（否则演示永远看不到"已验证"）', Array.isArray(parsed.claims) && parsed.claims.length > 0);
  check(
    '★ mock 的 claims 通过校验 → symbolic（P-B2 的 MISSING→SUPPLEMENTED→VERIFIED 可达）',
    verifySupplementContent({ content: parsed.content, claims: parsed.claims }).status === 'symbolic',
    verifySupplementContent({ content: parsed.content, claims: parsed.claims }),
  );
  check(
    'mock 正文保留"系统补充内容"标注（§2.3 要求显著标注，不得为画面删掉）',
    String(parsed.content).includes('系统补充内容'),
  );
}

/* ==================== 8. I18 一致性断言：验证状态不达标不得写成 VERIFIED ==================== */

section('8. I18 一致性断言：commitSupplement 必须拒绝"未验证却标 VERIFIED"');

{
  clearSessions();
  const session = createSession();
  const block = (verification) => ({
    id: `sup-${verification}`,
    sessionId: session.id,
    conceptId: 'kp-derivative',
    content: '补充正文',
    authorizedAt: new Date().toISOString(),
    verification,
  });

  let threw = false;
  try {
    commitSupplement(session.id, block('unverified'), 0, 'VERIFIED');
  } catch {
    threw = true;
  }
  check('★ verification=unverified 却传 status=VERIFIED → 抛错拒绝', threw);

  let failedThrew = false;
  try {
    commitSupplement(session.id, block('failed'), 0, 'VERIFIED');
  } catch {
    failedThrew = true;
  }
  check('★ verification=failed 却传 status=VERIFIED → 抛错拒绝', failedThrew);

  // 正向：达标时应当通过，否则断言只是"永远抛错"
  clearSessions();
  const session2 = createSession();
  let accepted = null;
  try {
    accepted = commitSupplement(
      session2.id,
      { ...block('symbolic'), sessionId: session2.id },
      0,
      'VERIFIED',
    );
  } catch (error) {
    accepted = null;
    console.log(`      （正向用例抛错：${error.message}）`);
  }
  check('★ verification=symbolic 时 status=VERIFIED 正常提交（反例：断言不是恒抛）', accepted !== null);

  clearSessions();
  const session3 = createSession();
  let untouched = null;
  try {
    untouched = commitSupplement(session3.id, { ...block('unverified'), sessionId: session3.id }, 0, 'SUPPLEMENTED');
  } catch {
    untouched = null;
  }
  check('未验证内容标 SUPPLEMENTED 是合法的（没有被过度收紧）', untouched !== null);
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
