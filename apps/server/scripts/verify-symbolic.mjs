/**
 * 符号验证的回归脚本（C 负责接口层，见选型文档 §6）
 *
 * ### 与教学模块的分工
 *
 * 固定案例的**期望值表只有一份**，定义在 `packages/teaching/src/symbolic.ts` 的
 * `FIXED_CASES` 里。本脚本**不复制那份期望值**，而是调用 `runFixedCases()` ——
 * 两处各写一遍必然漂移（这正是选型文档 §6 要求的"共用同一期望值表"）。
 *
 * 本脚本额外覆盖教学模块不便自测的部分：**边界与降级行为**
 * （非法表达式、超长输入、超预算、空输入），确认这些情况都**不抛异常**、
 * 只降级为 `unverified`。
 *
 * **不消耗任何模型额度**，也不访问网络。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:symbolic
 */

import {
  FIXED_CASES,
  runFixedCases,
  supplementGap,
  verifyClaims,
} from '@lc/teaching';

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

console.log('=== 符号验证回归 ===\n');

/* ---------- 1. 固定案例基线（期望值与教学模块共用同一份） ---------- */
console.log(`1. 固定案例基线（共 ${FIXED_CASES.length} 条，期望值取自 @lc/teaching 的 FIXED_CASES）`);
{
  const { allPassed, results } = runFixedCases();
  for (const result of results) {
    check(
      `${result.name} → ${result.expect}`,
      result.passed,
      `实际 ${result.actual}（${result.detail}）`,
    );
  }
  check('★ 三个 §7.1 固定案例全部通过', allPassed);
}

/* ---------- 2. 整体状态汇总规则 ---------- */
console.log('\n2. 整体状态汇总');
{
  const allOk = verifyClaims([
    { kind: 'derivative', expr: 'x^2', at: 2, claimed: 4 },
    { kind: 'derivative', expr: 'x^3', at: 1, claimed: 3 },
  ]);
  check('全对 → symbolic', allOk.status === 'symbolic', allOk.status);

  const hasFail = verifyClaims([
    { kind: 'derivative', expr: 'x^2', at: 2, claimed: 4 },
    { kind: 'derivative', expr: 'x^3', at: 1, claimed: 99 },
  ]);
  check('★ 任一判错 → failed', hasFail.status === 'failed', hasFail.status);

  const empty = verifyClaims([]);
  check('空输入 → unverified（不假装通过）', empty.status === 'unverified', empty.status);

  check('返回逐条判定且顺序一致', hasFail.verdicts.length === 2);
  check('返回耗时字段', typeof allOk.durationMs === 'number');
}

/* ---------- 3. 边界：非法与超长输入必须降级，且不抛异常 ---------- */
console.log('\n3. 边界与降级（关键：绝不抛异常、绝不假装通过）');
{
  const cases = [
    ['非法表达式', { kind: 'derivative', expr: 'x^^2 +', at: 1, claimed: 1 }],
    ['空表达式', { kind: 'derivative', expr: '', at: 1, claimed: 1 }],
    ['超长表达式', { kind: 'derivative', expr: 'x'.repeat(500), at: 1, claimed: 1 }],
    ['除零产生非有限值', { kind: 'derivative', expr: '1/x', at: 0, claimed: 0 }],
    ['未知断言类型', { kind: 'unknown-kind', expr: 'x', claimed: 1 }],
  ];

  for (const [label, claim] of cases) {
    let threw = null;
    let result = null;
    try {
      result = verifyClaims([claim]);
    } catch (error) {
      threw = error;
    }
    check(`★ ${label}：不抛异常`, threw === null, threw ? String(threw) : '');
    check(
      `${label}：降级为 unverified`,
      result !== null && result.status === 'unverified',
      result ? result.status : '无结果',
    );
  }
}

/* ---------- 4. 切线：化简与取样双通道 ---------- */
console.log('\n4. 切线判定的两条通道');
{
  // 化简通道：两式相减能化简为 0
  const simplified = verifyClaims([
    { kind: 'tangent', expr: 'x^2', at: 3, claimed: '6*x - 9' },
  ]);
  check('等价写法（6x−9）判通过', simplified.status === 'symbolic', simplified.status);

  // 判错通道
  const wrong = verifyClaims([{ kind: 'tangent', expr: 'x^2', at: 3, claimed: '6*x - 8' }]);
  check('★ 常数项差 1 也要判错', wrong.status === 'failed', wrong.status);

  // 同一函数不同等价写法（展开式）
  const expanded = verifyClaims([
    { kind: 'tangent', expr: 'x^2', at: 1, claimed: '2*x - 1' },
  ]);
  check('x² 在 1 处切线 y=2x−1 判通过', expanded.status === 'symbolic', expanded.status);
}

/* ---------- 5. 单调与极值：负例必须判错（防止放水） ---------- */
console.log('\n5. 单调与极值（负例必须判错）');
{
  const goodMonotonic = verifyClaims([
    {
      kind: 'monotonic',
      expr: 'x^3 - 3*x',
      claimed: { inc: [[-Infinity, -1], [1, Infinity]], dec: [[-1, 1]] },
    },
  ]);
  check('x³−3x 正确单调区间判通过', goodMonotonic.status === 'symbolic', goodMonotonic.status);

  const badMonotonic = verifyClaims([
    { kind: 'monotonic', expr: 'x^3 - 3*x', claimed: { inc: [[-2, 2]], dec: [] } },
  ]);
  check('★ 把含递减段的区间声称递增 → 判错', badMonotonic.status === 'failed', badMonotonic.status);

  const goodExtremum = verifyClaims([
    { kind: 'extremum', expr: 'x^3 - 3*x', claimed: [-1, 1] },
  ]);
  check('x³−3x 极值点 ±1 判通过', goodExtremum.status === 'symbolic', goodExtremum.status);

  const badExtremum = verifyClaims([{ kind: 'extremum', expr: 'x^3', claimed: [0] }]);
  check('★ x³ 在 0 处不变号 → 判错', badExtremum.status === 'failed', badExtremum.status);
}

/* ---------- 6. 超预算：不阻断，只降级 ---------- */
console.log('\n6. 时间预算');
{
  const many = Array.from({ length: 40 }, (_, index) => ({
    kind: 'derivative',
    expr: 'x^2',
    at: index + 1,
    claimed: (index + 1) * 2,
  }));
  // 预算设为 0，第一轮循环即超预算
  const bounded = verifyClaims(many, { budgetMs: 0 });
  check('★ 超预算不抛异常', bounded !== null);
  check('超预算时剩余断言标 unverified', bounded.verdicts.every((v) => v.status === 'unverified'));
  check('超预算不阻断（仍返回全部逐条结果）', bounded.verdicts.length === many.length);
  check('超预算不误判为 failed', bounded.status === 'unverified', bounded.status);
}

/* ---------- 7. 容差可配 ---------- */
console.log('\n7. 容差');
{
  const tight = verifyClaims([{ kind: 'derivative', expr: 'x^2', at: 1, claimed: 2.0001 }]);
  check('默认容差 1e-9 下 2.0001 判错', tight.status === 'failed', tight.status);

  const loose = verifyClaims([{ kind: 'derivative', expr: 'x^2', at: 1, claimed: 2.0001 }], {
    tolerance: 0.001,
  });
  check('容差放宽到 1e-3 后判通过', loose.status === 'symbolic', loose.status);
}

/* ---------- 8. 接线：supplementGap 如何把断言变成验证状态 ---------- */
console.log('\n8. 接线（supplementGap：模型输出 → 验证状态）');
{
  const input = {
    conceptId: 'derivative',
    conceptName: '导数',
    reason: '材料未覆盖',
    materials: [],
  };

  /** 造一个只返回固定字符串的假模型调用函数（不联网、不消耗额度） */
  const fakeCall = (raw) => async () => raw;

  // ① 模型按结构返回、结论正确 → symbolic
  const good = await supplementGap(
    fakeCall(
      JSON.stringify({
        content: '导数的定义是……',
        claims: [{ kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 }],
      }),
    ),
    input,
  );
  check('★ 结论正确 → verification = symbolic', good.verification === 'symbolic', good.verification);
  check('正文被正确取出', good.content.startsWith('导数的定义'), good.content);
  check('断言被解析出 1 条', good.claims.length === 1, String(good.claims.length));

  // ② 结论写错 → failed（"不许放水"的关键一条）
  const bad = await supplementGap(
    fakeCall(
      JSON.stringify({
        content: '导数的定义是……',
        claims: [{ kind: 'derivative', expr: 'x^2', at: 1, claimed: 99 }],
      }),
    ),
    input,
  );
  check('★ 结论写错 → verification = failed', bad.verification === 'failed', bad.verification);

  // ③ 没有断言 → unverified（不得当成"验证通过"）
  const none = await supplementGap(
    fakeCall(JSON.stringify({ content: '纯文字说明', claims: [] })),
    input,
  );
  check('★ 无可验证断言 → unverified', none.verification === 'unverified', none.verification);
  check('此时断言数为 0', none.claims.length === 0, String(none.claims.length));

  // ④ 模型没按 JSON 返回 → 正文保留、判 unverified（不因解析失败丢掉内容）
  const plain = await supplementGap(fakeCall('导数的定义是：一个极限……'), input);
  check('★ 非 JSON 输出：正文仍保留', plain.content.includes('一个极限'), plain.content);
  check('★ 非 JSON 输出：判 unverified', plain.verification === 'unverified', plain.verification);

  // ⑤ 结构畸形的断言被丢弃（不是"修复"）
  const malformed = await supplementGap(
    fakeCall(
      JSON.stringify({
        content: '说明',
        claims: [
          { kind: 'derivative', expr: 'x^2' },
          { kind: 'monotonic', expr: 'x', claimed: { inc: [[5, 1]], dec: [] } },
          { kind: 'nonsense', expr: 'x' },
        ],
      }),
    ),
    input,
  );
  check('★ 畸形断言被丢弃（不修复）', malformed.claims.length === 0, String(malformed.claims.length));
  check('丢弃后判 unverified', malformed.verification === 'unverified', malformed.verification);

  // ⑥ 用大数哨兵表示开区间（JSON 没有 Infinity）
  const sentinel = await supplementGap(
    fakeCall(
      JSON.stringify({
        content: 'x³−3x 的单调性……',
        claims: [
          {
            kind: 'monotonic',
            expr: 'x^3 - 3*x',
            claimed: { inc: [[-1000000, -1], [1, 1000000]], dec: [[-1, 1]] },
          },
        ],
      }),
    ),
    input,
  );
  check('★ 用 ±1000000 表示开区间也判通过', sentinel.verification === 'symbolic', sentinel.verification);
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
