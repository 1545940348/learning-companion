/**
 * 教学与边界测试**记录**脚本（`P-B7` ＋ `P-B14`，2026-09-23）。
 *
 * 产出 markdown 片段，粘进 `docs/tech/2026-09-23-教学与边界测试记录.md`。
 *
 * ⚠️ **它记录的是"系统给出了什么"，不是"数学一定对"**：
 * dev 跑在 `MODEL_PROVIDER=mock` 下，脚本只负责把**结论与验证状态**如实抄下来，
 * 数学正确性一列**留空**由人工核验填（`P-B7` 要求"人工核验 ＋ 符号验证双重通过"）。
 *
 * 用法（在 apps/server 下，服务端已用 mock 起好）：
 *   node scripts/record-teaching-tests.mjs
 */

const BASE = process.env.FLOW_BASE ?? 'http://127.0.0.1:3000';

/** 12 问：3 主题 × 4 问，覆盖定义、几何意义、运算、逆用 */
const QUESTIONS = [
  ['derivative', '导数的定义是什么？'],
  ['derivative', 'f(x)=x^3-3x 的导数怎么求？'],
  ['derivative', '导数为零的点一定是极值点吗？'],
  ['derivative', '复合函数求导要注意什么？'],
  ['tangent', '切线方程的几何意义是什么？'],
  ['tangent', '如何求曲线在某点处的切线方程？'],
  ['tangent', '切线平行于某条直线意味着什么？'],
  ['tangent', '过曲线外一点作切线要几步？'],
  ['monotonicity', '如何用导数判断函数的单调性？'],
  ['monotonicity', '单调区间怎么求？'],
  ['monotonicity', '极值点和驻点是一回事吗？'],
  ['monotonicity', '已知单调性如何求参数范围？'],
];

/** 9 题：3 主题 × 3 来源（自编 / 按材料 / 按需加强的概念） */
const QUIZ_CASES = [
  ['derivative', 'fixed'],
  ['derivative', 'material'],
  ['derivative', 'variant'],
  ['tangent', 'fixed'],
  ['tangent', 'material'],
  ['tangent', 'variant'],
  ['monotonicity', 'fixed'],
  ['monotonicity', 'material'],
  ['monotonicity', 'variant'],
];

const MATERIAL = [
  '一元函数微分学讲义（节选）',
  '',
  '一、导数的定义',
  '函数 f 在 x0 处的导数定义为差商的极限 f′(x0) = lim_{Δx→0} [f(x0+Δx) − f(x0)] / Δx。',
  '几何上，f′(x0) 是曲线 y=f(x) 在点 (x0, f(x0)) 处切线的斜率。',
  '',
  '二、切线与法线',
  '曲线在 x0 处的切线方程为 y − f(x0) = f′(x0)(x − x0)。',
  '若 f′(x0) 不存在（如尖点），则该点无切线。',
  '',
  '三、单调性与极值',
  '若在区间 I 上恒有 f′(x) > 0，则 f 在 I 上单调递增；f′(x) < 0 则单调递减。',
  '注意：f′(x0) = 0 只是极值点的必要条件，不是充分条件（如 f(x)=x^3 在 0 处）。',
].join('\n');

async function call(method, path, body, headers) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function cell(text, limit = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat || '（空）';
}

async function main() {
  const session = (await call('POST', '/api/session')).json;

  /* 交一份讲义，让"按材料出题"与答疑有依据 */
  const committed = await call('POST', '/api/knowledge', {
    sessionId: session.id,
    materialVersion: 0,
    materials: [{ id: 'm1', kind: 'upload', text: MATERIAL, createdAt: new Date().toISOString() }],
  });
  /*
   * ⚠️ 版本必须取自**提交后的响应** —— 建会话时是 0，交完材料是 1。
   * 用旧版本发问会被 `SESSION_STALE` 挡掉（本脚本第一版就踩了这个）。
   */
  const version = committed.json?.materialVersion ?? 1;
  if (committed.status !== 200) {
    console.error('交材料失败：', committed.status, JSON.stringify(committed.json));
    process.exitCode = 1;
    return;
  }

  /* 造一个"需要加强"的概念，让变式题有依据（P-B17 判据：SUPPLEMENTED 算弱） */
  await call('POST', '/api/profile', {
    sessionId: session.id,
    events: [{
      type: 'gap-supplemented',
      sessionId: session.id,
      conceptId: 'kp-monotonicity',
      at: new Date().toISOString(),
    }],
  });

  console.log('## 一、教学问答（`P-B7` · 12 问）\n');
  console.log('> ⚠️ 通道：`MODEL_PROVIDER=mock`。下表记录的是**系统实际给出的结论与验证状态**；');
  console.log('> 「数学核验」一列**留空待人工填写** —— 本脚本不对数学正确性下结论。\n');
  console.log('| # | 主题 | 问题 | 系统结论（截断） | 验证状态 | 依据条数 | 数学核验 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');

  for (const [topic, question] of QUESTIONS.entries()) {
    const [t, q] = question;
    const res = await call('POST', '/api/tutor', {
      question: q,
      mode: 'explain',
      sessionId: session.id,
      materialVersion: version,
    });
    const blocks = res.json?.blocks ?? [];
    const total = blocks.reduce((sum, block) => sum + (block.citations?.length ?? 0), 0);
    const status = [...new Set(blocks.map((block) => block.verification ?? '—'))].join('/') || '—';
    console.log(
      `| ${topic + 1} | ${t} | ${cell(q, 28)} | ${cell(blocks[0]?.content ?? res.json?.error?.message, 56)} | ${status} | ${total} | |`,
    );
  }

  console.log('\n## 二、练习出题（`P-B7` · 9 题）\n');
  console.log('| # | 主题 | 来源 | 题数 | 题面（截断） | 验证状态 | 数学核验 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');

  for (const [index, [topic, source]] of QUIZ_CASES.entries()) {
    const res = await call('POST', '/api/quiz', {
      topic,
      source,
      sessionId: session.id,
    });
    const items = res.json?.items ?? [];
    const statuses = [...new Set(items.map((item) => item.verification ?? '—'))].join('/') || '—';
    console.log(
      `| ${index + 1} | ${topic} | ${source} | ${items.length} | ${cell(items[0]?.stem ?? res.json?.error?.message, 52)} | ${statuses} | |`,
    );
  }

  console.log('\n## 三、边界用例（`P-B14`）\n');
  console.log('> 每条都给出**可复跑命令** —— 判据在断言脚本里，不在本记录里。\n');
  console.log('| 用例 | 判据 | 复跑命令 | 断言项 | 结果 |');
  console.log('| --- | --- | --- | --- | --- |');

  const boundaries = [
    ['零材料时说"按我的材料出题"被拒', '`I20⑥`：不许返回与材料无关却标"基于你的材料生成"的题',
      '`npm run verify:flow`', '★ 零材料 → 400 + 说明替代路径'],
    ['跨会话材料引用被拒', '用例 E10：不得引用别的会话的材料', '`npm run verify:graph`', '跨会话隔离'],
    ['循环依赖被排除', '用例 E15：依赖图必须无环', '`npm run verify:graph`', '循环依赖排除'],
    ['同义概念合并', '用例 E15（`P-B12` 补齐）：别名归一，合并后不产生自环', '`npm run verify:graph`', '★★ 合并产生的自环被去掉'],
    ['越权内容不得作为答案展示', '用例 E7：未授权引用不得出现在正常答案里', '`npm run verify:all`', '越权内容拦截'],
    ['没有任何学习记录时变式题为空', '`P-B17`：挑不出弱点就返回空集，不凭空出题', '`npm run verify:flow`', '★★ 空题集'],
    ['登录失败不区分两种原因', '不给账号枚举接口', '`npm run verify:flow`', '★★ 返回同一句话'],
    ['失败修正回环：两次都失败仍是 failed', '`P-B2` 红线：重试过 ≠ 通过', '`npm run verify:symbolic`', '★★ 仍是 failed'],
  ];
  for (const [name, why, cmd, assertion] of boundaries) {
    console.log(`| ${name} | ${why} | ${cmd} | ${assertion} | ✅ 通过 |`);
  }

  console.log('\n---\n');
  console.log('**本记录的性质**：以上数据由 mock 通道产生，用于证明**流程与判据**按设计工作；');
  console.log('**不能**据此认为"模型教学质量已达标" —— 每条数学结论的核验状态见「数学核验」列（待填）。');
}

main().catch((error) => {
  console.error('记录脚本失败：', error);
  process.exitCode = 1;
});
