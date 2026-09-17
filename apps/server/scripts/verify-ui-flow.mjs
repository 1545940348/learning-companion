/**
 * 界面调用顺序的端到端验证（需要**已启动的服务端**）。
 *
 * 与 verify:store / errors / guards / graph 的区别：那四个是纯函数与 store 层，
 * 离线可跑；本脚本打真实 HTTP，按前端界面的**实际调用顺序**走一遍材料路径。
 *
 * 为什么值得单独有：说明书的阶段门槛写的是「核心闭环走通」，
 * 而每个接口单独能跑不等于按界面的顺序连起来能跑 —— 版本护栏、
 * 幂等补充、跨会话隔离这些只有按顺序打才会暴露。
 *
 * 不并入 verify:all（后者不依赖运行中的服务）。
 *
 * 用法：
 *   1. 另开一个终端启动服务端（不需要真实密钥）：
 *        cd apps/server && MODEL_PROVIDER=mock PORT=3000 npx tsx src/index.ts
 *   2. 运行：
 *        npm run verify:flow -w @lc/server
 *   可用环境变量 FLOW_BASE 覆盖地址。
 */

const BASE = process.env.FLOW_BASE ?? 'http://127.0.0.1:3000';
let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  ok ? passed++ : failed++;
  console.log(`  [${ok ? '通过' : '失败'}] ${label}${ok ? '' : ` —— ${JSON.stringify(detail)}`}`);
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

console.log('=== 按界面调用顺序走材料路径 ===\n');

const materialText =
  "判断 f(x) 的单调性：只需看 f'(x) 的符号。f'(x) > 0 时函数在区间上单调递增，" +
  "f'(x) < 0 时单调递减，f'(x) = 0 的点是可能的分界点。";

/* 1. 新建会话 */
const session = (await call('POST', '/api/session')).json;
check('① 新建会话 → 空图谱', session.graph.nodes.length === 0 && session.materialVersion === 0);

/* 2. 先过识别层（对应界面提交前调的 /api/parse），再提交材料 */
const parsed = (await call('POST', '/api/parse', { text: materialText })).json;
check('②a 识别接口可用，返回文本与低置信度字段', typeof parsed.text === 'string' && Array.isArray(parsed.lowConfidence));
check(
  '②a 未接入的识别通道如实报告（不用占位描述冒充已解析）',
  Array.isArray(parsed.unavailable) && parsed.unavailable.includes('formula'),
  parsed.unavailable,
);

const material = {
  id: 'm-1',
  kind: 'upload',
  text: parsed.text,
  createdAt: new Date().toISOString(),
};
const knowledge = (
  await call('POST', '/api/knowledge', { sessionId: session.id, materials: [material] })
).json;
check('② 解析材料 → 拿到知识点', Array.isArray(knowledge.points) && knowledge.points.length > 0, knowledge.points?.length);
check('② 版本递增到 1', knowledge.materialVersion === 1);
check('② 图谱随材料落盘（节点数 > 0）', knowledge.graph.nodes.length > 0, knowledge.graph.nodes.length);
check(
  '② 前置关系存在且为 MISSING（演示案例：单调性缺导数）',
  knowledge.prerequisites.some((p) => p.status === 'MISSING'),
  knowledge.prerequisites?.map((p) => `${p.conceptId}:${p.status}`),
);
check(
  '② 验证状态缺省落 unverified（不伪报已验证）',
  knowledge.prerequisites.every((p) => p.verification === 'unverified'),
  knowledge.prerequisites?.map((p) => p.verification),
);

const gapConcept = knowledge.prerequisites[0].conceptId;
const gapReason = knowledge.prerequisites[0].reason;

/* 3. 读取图谱（对应图谱面板） */
const graph = (await call('GET', `/api/graph?sessionId=${session.id}`)).json;
check('③ GET /api/graph → 能读到刚落盘的节点', graph.nodes.length === knowledge.graph.nodes.length);

/* 4. 答疑（材料路径，带正确版本） */
const tutor = (
  await call('POST', '/api/tutor', {
    sessionId: session.id,
    materialVersion: knowledge.materialVersion,
    question: "为什么 f'(x) > 0 就能说明递增？",
    mode: 'hint',
  })
).json;
check('④ 材料路径答疑成功', Array.isArray(tutor.blocks) && tutor.blocks.length > 0, tutor.blocks?.length);
check('④ 回答块带验证状态', tutor.blocks.every((b) => typeof b.verification === 'string'));
check('④ 标注基于材料', tutor.basedOnMaterial === true);

/* 5. 版本护栏（对应用例 E8：旧请求结果必须被丢弃） */
const stale = await call('POST', '/api/tutor', {
  sessionId: session.id,
  materialVersion: knowledge.materialVersion - 1,
  question: '旧版本的提问',
  mode: 'explain',
});
check('⑤ 过期版本提问被拒（409 SESSION_STALE）', stale.status === 409, stale.status);
check('⑤ 标记为可重试（前端据此给重试按钮）', stale.json?.error?.retryable === true, stale.json?.error);

/* 6. 一键补充缺口 */
const gap = (
  await call('POST', '/api/gap', {
    sessionId: session.id,
    materialVersion: knowledge.materialVersion,
    conceptId: gapConcept,
    reason: gapReason,
  })
).json;
check('⑥ 补充成功 → 状态 SUPPLEMENTED', gap.status === 'SUPPLEMENTED', gap.status);
check('⑥ 验证状态为 unverified（符号引擎未接入）', gap.verification === 'unverified', gap.verification);
check('⑥ 版本递增到 2', gap.materialVersion === 2);
check('⑥ 返回补充块 ID', typeof gap.supplementBlockId === 'string');
check('⑥ 补充内容明显是一段说明（非空）', gap.content.length > 50, gap.content?.length);

/* 7. 补充后图谱的入边应转为 SUPPLEMENTED */
const graphAfter = (await call('GET', `/api/graph?sessionId=${session.id}`)).json;
const touched = graphAfter.edges.filter((e) => e.to === gapConcept);
check(
  '⑦ 图谱入边已转 SUPPLEMENTED（若模型给出了边）',
  graphAfter.edges.length === 0 || touched.every((e) => e.status === 'SUPPLEMENTED'),
  graphAfter.edges.map((e) => `${e.to}:${e.status}`),
);
check('⑦ 图谱节点未被增删', graphAfter.nodes.length === knowledge.graph.nodes.length);

/* 8. 幂等：重复补充同一缺口 */
const again = (
  await call('POST', '/api/gap', {
    sessionId: session.id,
    materialVersion: gap.materialVersion,
    conceptId: gapConcept,
    reason: gapReason,
  })
).json;
check('⑧ 重复补充返回同一补充块（幂等，避免无谓消耗）', again.supplementBlockId === gap.supplementBlockId);

/* 9. 练习：固定题 + 按材料出题 */
const fixed = (await call('POST', '/api/quiz', { topic: 'monotonicity', source: 'fixed' })).json;
check('⑨ 固定题 3 道，验证状态 human', fixed.items.length === 3 && fixed.items.every((i) => i.verification === 'human'));
check('⑨ 固定题含答案与解析（提交后才由前端展示）', fixed.items.every((i) => i.answer && i.explanation));

const generated = (
  await call('POST', '/api/quiz', { topic: 'monotonicity', source: 'material', sessionId: session.id })
).json;
check('⑨ 按材料出题 2 道', generated.items.length === 2, generated.items?.length);
check('⑨ 生成题来源标为 material', generated.items.every((i) => i.source === 'material'));
check('⑨ 生成题验证状态 unverified（不伪报）', generated.items.every((i) => i.verification === 'unverified'));

/* 10. 画像 */
const profile = (
  await call('POST', '/api/profile', {
    sessionId: session.id,
    events: [
      { type: 'quiz-attempted', sessionId: session.id, at: new Date().toISOString(), payload: { total: 2, correct: 1 } },
    ],
  })
).json;
check('⑩ 画像返回 mastery/gaps', typeof profile.mastery === 'object' && Array.isArray(profile.gaps));

const profile2 = (
  await call('POST', '/api/profile', {
    sessionId: session.id,
    events: [{ type: 'gap-supplemented', sessionId: session.id, conceptId: gapConcept, at: new Date().toISOString() }],
  })
).json;
check('⑩ gap-supplemented 计入画像', profile2.mastery[gapConcept] === 'SUPPLEMENTED', profile2.mastery);

/* 11. 轻路径（不建会话） */
const light = (
  await call('POST', '/api/tutor', { sessionId: null, materialVersion: 0, question: '什么是切线？', mode: 'explain' })
).json;
check('⑪ 轻路径（sessionId=null）可答疑', Array.isArray(light.blocks) && light.blocks.length > 0);
check('⑪ 轻路径标注未基于材料', light.basedOnMaterial === false);

/* 12. 跨会话隔离（用例 E10） */
const other = (await call('POST', '/api/session')).json;
const otherGraph = (await call('GET', `/api/graph?sessionId=${other.id}`)).json;
check('⑫ 新会话读不到上一会话的图谱（E10）', otherGraph.nodes.length === 0 && otherGraph.edges.length === 0);

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
process.exitCode = failed > 0 ? 1 : 0;
