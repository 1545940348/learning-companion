/**
 * 图谱落盘 / 画像 / 契约常量 验证脚本
 *
 * 对应说明书 V2.0：
 * 1. §3.3 图谱与材料**同一次原子提交**（这是 C1 要解决的核心问题 —— 此前
 *    `/api/knowledge` 算完即丢，导致 `/api/graph` 无数据可读）；
 * 2. §2.3 图谱邻域只做一层展开，不做多跳；
 * 3. §3.4 补充缺口后被补齐概念的入边转 SUPPLEMENTED 并挂上补充块证据；
 * 4. §3.2 六态与「SUPPLEMENTED 不因学生说已会转 LOCAL」；
 * 5. §4.2 未验证内容不得默认视为正确（缺省 `unverified`）；
 * 6. §5.3 契约常量：5 份 / 15000 字、90 秒预算；
 * 7. 用例 E10 跨会话隔离、E15 循环依赖排除。
 *
 * 全部为纯函数/store 调用 + 注入的假模型函数，**不消耗任何模型额度、不需要密钥**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:graph
 */

import {
  ATTRIBUTABLE_KINDS,
  FIXED_QUIZ,
  FIXED_QUIZ_MISCONCEPTIONS,
  analyzeKnowledge,
  answerQuestion,
  attributeQuizAttempt,
  misconceptionKey,
  orchestrateQuiz,
  orchestrateTutor,
} from '@lc/teaching';
import {
  DEFAULT_VERIFICATION,
  MATERIAL_LIMITS,
  MODEL_TIMEOUT_MS,
} from '@lc/contracts';
import {
  SessionVersionConflictError,
  clearSessions,
  commitMaterials,
  commitProfileEvents,
  commitSupplement,
  createSession,
  getGraphNeighborhood,
  getProfile,
  getSession,
  listSessionSummaries,
} from '../src/store/index.js';
import { defaultStatusForApiCode, isRetryableApiCode } from '../src/http/error-response.js';
import { createMockAdapter } from '../src/model/index.js';

let passed = 0;
let failed = 0;

/** 取存储中的会话；不存在即抛错，避免测试在"读不到"时静默通过 */
function getSessionOrThrow(id) {
  const session = getSession(id);
  if (!session) throw new Error(`测试用例错误：会话不存在 ${id}`);
  return session;
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function material(id, text) {
  return { id, kind: 'upload', text, createdAt: new Date().toISOString() };
}

function point(id, extra = {}) {
  return { id, name: id, explanation: `${id} 的说明`, citations: [], ...extra };
}

function edge(from, to, extra = {}) {
  return {
    from,
    to,
    kind: 'prerequisite',
    status: 'MISSING',
    reason: `${from} 需要 ${to}`,
    evidence: [],
    ...extra,
  };
}

/** 注入的假模型函数：返回固定 JSON，用于测教学模块的归一逻辑 */
function fakeCall(payload) {
  return async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));
}

clearSessions();

/* ==================== 1. 图谱落盘 ==================== */

console.log('=== 1. 图谱与材料同一次原子提交（§3.3） ===\n');

{
  const session = createSession();
  check('新会话图谱为空', session.graph.nodes.length === 0 && session.graph.edges.length === 0);
  check('新会话 materialVersion = 0', session.materialVersion === 0);

  const other = createSession();
  check(
    '★ 两个会话的图谱不是同一个对象（避免共享可变对象）',
    session.graph !== other.graph,
  );

  const graph = { nodes: [point('derivative')], edges: [edge('monotonicity', 'derivative')] };
  const afterCommit = commitMaterials(session.id, [material('m1', '单调性讲义')], 0, graph);

  check('材料与图谱一次提交后版本 +1', afterCommit.materialVersion === 1);
  check('图谱已落盘：节点 1 个', afterCommit.graph.nodes.length === 1);
  check('图谱已落盘：边 1 条', afterCommit.graph.edges.length === 1);
  check('★ 落盘后仍可读回（/api/graph 的前提）', afterCommit.graph.edges[0].to === 'derivative');
}

{
  // 模型本次没抽到关系，不构成"删掉旧图谱"的理由
  const session = createSession();
  const graph = { nodes: [point('derivative')], edges: [edge('monotonicity', 'derivative')] };
  const first = commitMaterials(session.id, [material('m1', 't1')], 0, graph);
  const second = commitMaterials(session.id, [material('m2', 't2')], first.materialVersion);

  check('★ 只提交材料、不提交图谱时保留旧图谱', second.graph.edges.length === 1);
  check('版本仍然递增', second.materialVersion === first.materialVersion + 1);
  check('材料累积为 2 份', second.materials.length === 2);
}

{
  const session = createSession();
  const same = commitMaterials(session.id, [], 0, { nodes: [], edges: [] });
  check('材料与图谱都为空时不递增版本', same.materialVersion === 0);
}

{
  const session = createSession();
  const graph = { nodes: [point('derivative')], edges: [] };
  const first = commitMaterials(session.id, [material('m1', 't1')], 0, graph);

  let conflict = null;
  try {
    // 用过期版本 0 提交，模拟并发旧响应
    commitMaterials(session.id, [material('m2', 't2')], 0, graph);
  } catch (error) {
    conflict = error;
  }
  check('★ 过期版本提交被拒（SessionVersionConflictError）', conflict instanceof SessionVersionConflictError);
  check('拒绝后图谱未被覆盖', getGraphNeighborhood(getSessionOrThrow(session.id), null).edges.length === 0);
  check('拒绝后版本未变', getSessionOrThrow(session.id).materialVersion === first.materialVersion);
}

/* ==================== 2. 图谱邻域（§2.3） ==================== */

console.log('\n=== 2. 图谱邻域：只做一层，不做多跳 ===\n');

{
  const session = createSession();
  // 关系：A → B → C（A 依赖 B，B 依赖 C）
  const graph = {
    nodes: [point('A'), point('B'), point('C')],
    edges: [edge('A', 'B'), edge('B', 'C')],
  };
  commitMaterials(session.id, [material('m1', 't1')], 0, graph);
  const stored = getSessionOrThrow(session.id);

  const full = getGraphNeighborhood(stored, null);
  check('不传中心点返回全量（3 节点 / 2 边）', full.nodes.length === 3 && full.edges.length === 2);
  check('全量的 rootConceptId 为 null', full.rootConceptId === null);

  const aroundB = getGraphNeighborhood(stored, 'B');
  check('以 B 为中心：包含 A、B、C 三个节点', aroundB.nodes.length === 3);
  check('以 B 为中心：包含 2 条边', aroundB.edges.length === 2);

  const aroundA = getGraphNeighborhood(stored, 'A');
  check(
    '★ 以 A（端点）为中心：只到 B，不做多跳到 C（一层邻域）',
    aroundA.nodes.length === 2 && aroundA.edges.length === 1,
  );
  check(
    '★ 邻域不返回无关节点',
    !aroundA.nodes.some((node) => node.id === 'C'),
  );
}

{
  // 用例 E10：跨会话隔离
  const a = createSession();
  const b = createSession();
  commitMaterials(
    a.id,
    [material('m1', 't1')],
    0,
    { nodes: [point('x')], edges: [edge('y', 'x')] },
  );

  const graphB = getGraphNeighborhood(getSessionOrThrow(b.id), null);
  check('★ 会话 B 读不到会话 A 的图谱（用例 E10）', graphB.nodes.length === 0 && graphB.edges.length === 0);
}

/* ==================== 3. 补充缺口回写图谱（§3.4） ==================== */

console.log('\n=== 3. 补充缺口后被补齐概念的入边转 SUPPLEMENTED ===\n');

{
  const session = createSession();
  commitMaterials(
    session.id,
    [material('m1', 't1')],
    0,
    {
      nodes: [point('monotonicity'), point('derivative'), point('limit')],
      // 边 1 指向 derivative（本次要补的缺口）；边 2 指向 limit（无关）
      edges: [edge('monotonicity', 'derivative'), edge('monotonicity', 'limit')],
    },
  );
  const stored = getSessionOrThrow(session.id);

  const supplement = {
    id: 'sup-derivative',
    sessionId: session.id,
    conceptId: 'derivative',
    content: '导数描述函数在某点的瞬时变化率……',
    authorizedAt: new Date().toISOString(),
    verification: 'unverified',
  };
  const after = commitSupplement(session.id, supplement, stored.materialVersion, 'SUPPLEMENTED');

  const target = after.graph.edges.find((item) => item.to === 'derivative');
  const untouched = after.graph.edges.find((item) => item.to === 'limit');

  check('★ 被补齐概念的入边状态转 SUPPLEMENTED', target.status === 'SUPPLEMENTED');
  check('★ 入边挂上指向补充块的证据（来源可定位）', target.evidence.some((item) => item.refId === 'sup-derivative'));
  check('证据的来源类别为 ai-supplement', target.evidence.at(-1).sourceType === 'ai-supplement');
  check('★ 无关概念的边不受影响', untouched.status === 'MISSING' && untouched.evidence.length === 0);
  check('补充后版本递增', after.materialVersion === stored.materialVersion + 1);
  check('图谱节点未被增删（不在补充阶段凭空造节点）', after.graph.nodes.length === 3);
}

/* ==================== 4. 六态与「我已掌握」不改覆盖状态（§3.2、§2.3） ==================== */

console.log('\n=== 4. 六态与画像事件语义 ===\n');

{
  const session = createSession();
  const stored = getSessionOrThrow(session.id);

  commitProfileEvents(stored, [
    { type: 'gap-supplemented', sessionId: session.id, conceptId: 'derivative', at: new Date().toISOString() },
  ]);
  const afterSupplement = getProfile(session.id);
  check('gap-supplemented 写入 mastery', afterSupplement.mastery.derivative === 'SUPPLEMENTED');
  check('gap-supplemented 写入缺口历史', afterSupplement.gaps.length === 1);

  // 用例：学生点「我已掌握，继续」——只影响引导，不改变材料覆盖状态
  commitProfileEvents(stored, [
    { type: 'gap-claimed-known', sessionId: session.id, conceptId: 'derivative', at: new Date().toISOString() },
  ]);
  const afterClaim = getProfile(session.id);
  check(
    '★ 「我已掌握」不把 SUPPLEMENTED 改成 LOCAL / VERIFIED（§2.3）',
    afterClaim.mastery.derivative === 'SUPPLEMENTED',
  );

  commitProfileEvents(stored, [
    {
      type: 'quiz-attribution',
      sessionId: session.id,
      at: new Date().toISOString(),
      payload: { kind: 'calculation-error', pattern: '漏乘系数' },
    },
    {
      type: 'quiz-attribution',
      sessionId: session.id,
      at: new Date().toISOString(),
      payload: { kind: 'calculation-error', pattern: '漏乘系数' },
    },
  ]);
  const afterQuiz = getProfile(session.id);
  check('错题归因按 kind+pattern 累计', afterQuiz.misconceptions[0].count === 2);
}

/* ==================== 5. 契约常量与错误码表（§5.3） ==================== */

console.log('\n=== 5. 契约常量与错误码表 ===\n');

check('材料上限为 5 份（V2.0）', MATERIAL_LIMITS.maxMaterialsPerSession === 5, String(MATERIAL_LIMITS.maxMaterialsPerSession));
check('材料上限为 15000 字（V2.0）', MATERIAL_LIMITS.maxTextLength === 15000, String(MATERIAL_LIMITS.maxTextLength));
check('单次输入上限仍为 3000 字', MATERIAL_LIMITS.maxSingleInputLength === 3000);
check('图片上限仍为 5MB', MATERIAL_LIMITS.maxImageBytes === 5 * 1024 * 1024);

check('★ 请求总预算为 90 秒（V2.0，含验证）', MODEL_TIMEOUT_MS === 90_000, String(MODEL_TIMEOUT_MS));

check(
  '★ 未提供验证结果时缺省为 unverified（不得默认视为正确，§4.2）',
  DEFAULT_VERIFICATION === 'unverified',
  DEFAULT_VERIFICATION,
);

check('NOT_IMPLEMENTED → 501', defaultStatusForApiCode('NOT_IMPLEMENTED') === 501);
check('★ NOT_IMPLEMENTED 不可重试（重试也不会出现）', isRetryableApiCode('NOT_IMPLEMENTED') === false);
check('SESSION_STALE → 409 且可重试', defaultStatusForApiCode('SESSION_STALE') === 409 && isRetryableApiCode('SESSION_STALE'));

// 错误码表必须覆盖全部契约取值，缺一个就会在运行时读到 undefined
{
  const codes = [
    'BAD_REQUEST', 'NOT_FOUND', 'SESSION_STALE', 'UNAUTHORIZED_CONTENT',
    'MODEL_TIMEOUT', 'MODEL_ERROR', 'NOT_IMPLEMENTED', 'INTERNAL',
  ];
  const missing = codes.filter((code) => typeof defaultStatusForApiCode(code) !== 'number');
  check('★ 每个契约错误码都有状态码（一致性）', missing.length === 0, missing.join(','));
}

/* ==================== 6. 教学模块归一：验证状态与图谱结构 ==================== */

console.log('\n=== 6. 教学模块归一：验证状态、自依赖与循环依赖（用例 E15） ===\n');

{
  const raw = {
    points: [
      { id: 'monotonicity', name: '单调性', explanation: '…' },
      { id: 'derivative', name: '导数', explanation: '…', verification: 'symbolic' },
    ],
    prerequisites: [{ conceptId: 'derivative', conceptName: '导数', status: 'MISSING', reason: '…' }],
    graph: {
      edges: [
        { from: 'monotonicity', to: 'derivative', reason: '需要导数' },
        { from: 'derivative', to: 'derivative' }, // 自依赖 → 必须排除
        { from: 'derivative', to: 'monotonicity' }, // 与第一条构成环 → 必须排除
        { from: 'monotonicity', to: 'limit', kind: 'depends_on' },
      ],
    },
  };

  const result = await analyzeKnowledge(fakeCall(raw), { materials: [] });

  check('知识点被归一（缺 verification 时落 unverified）', result.points[0].verification === 'unverified');
  check('知识点显式 verification 被保留', result.points[1].verification === 'symbolic');
  check('前置关系缺 verification 时落 unverified', result.prerequisites[0].verification === 'unverified');
  check('图谱节点取自知识点', result.graph.nodes.length === 2);

  const pairs = result.graph.edges.map((item) => `${item.from}->${item.to}`);
  check('★ 自依赖边被排除（用例 E15）', !pairs.includes('derivative->derivative'), pairs.join(', '));
  check('★ 循环依赖边被排除（用例 E15）', !pairs.includes('derivative->monotonicity'), pairs.join(', '));
  check('合法边被保留（含非 prerequisite 关系）', pairs.includes('monotonicity->derivative') && pairs.includes('monotonicity->limit'));
  check('关系类型缺省为 prerequisite', result.graph.edges[0].kind === 'prerequisite');

  // 模型未返回 edges 时只有节点、没有边 —— 不凭 prerequisites 猜 from
  const noEdges = await analyzeKnowledge(fakeCall({ points: [point('a')] }), { materials: [] });
  check('★ 模型未给边时图谱只有节点、不猜关系', noEdges.graph.nodes.length === 1 && noEdges.graph.edges.length === 0);
}

{
  /*
   * 卡 0-4 / `I1`：**mock 通道必须真的产出关系边**。
   *
   * 为什么单独一段：无密钥的演示与录屏都走 mock。若 mock 不产出 `edges`，
   * 那"有边时界面不再显示『没有关系边』"这条前端断言就**只能靠合成图自证** ——
   * 合成图能证明渲染逻辑对，**证明不了"mock 这条路上真的有边"**
   * （与 `I31`/`I34` 同一类教训：mock 不保真 → 路径走不通 → 修了也看不到效果）。
   *
   * 顺带锁住**方向**：契约里 `from` = 依赖方、`to` = 被依赖方，
   * 写反了不会报错，但图谱分层与缺口判定都会错。
   */
  const mock = createMockAdapter();
  const mocked = await analyzeKnowledge(mock.call, {
    materials: [material('m1', "单调性讲义：f'(x) > 0 ⇒ 递增")],
  });

  check(
    '★ mock 通道产出显式关系边（此前恒为 0 条，界面永远看不到边）',
    mocked.graph.edges.length > 0,
    `edges=${mocked.graph.edges.length}`,
  );
  const mockedEdge = mocked.graph.edges[0];
  check(
    '★ 边的方向是「依赖方 → 被依赖方」（单调性依赖导数）',
    mockedEdge.from === 'kp-monotonicity' && mockedEdge.to === 'kp-derivative',
    `${mockedEdge.from} -> ${mockedEdge.to}`,
  );
  check('边的类型缺省为 prerequisite', mockedEdge.kind === 'prerequisite', mockedEdge.kind);
  check(
    '★ mock 的边端点与前置关系一致（to === prerequisites[].conceptId）',
    mocked.prerequisites.some((item) => item.conceptId === mockedEdge.to),
    mockedEdge.to,
  );
}

{
  // 边界判定与回答块的归一
  const raw = {
    scope: '完全不是合法取值',
    blocks: [{ content: '正文', sourceType: 'derived', citations: [] }],
  };
  const result = await answerQuestion(fakeCall(raw), {
    question: '为什么 f\' > 0 递增？',
    mode: 'explain',
    materials: [],
  });

  check('★ 非法 scope 不原样透传，落到 partial', result.scope === 'partial', result.scope);
  check('★ 回答块缺 verification 时落 unverified', result.blocks[0].verification === 'unverified');
  check('零材料时 basedOnMaterial 为 false', result.basedOnMaterial === false);
}

/* ==================== 会话摘要列表（GET /api/sessions，2026-09-23） ==================== */

console.log('\n=== 会话摘要：只列元信息、排序确定、不泄露正文 ===\n');
{
  /*
   * 这一节锁三件事，缺一件就等于没测：
   * ① 摘要字段取自**真实会话**（不是现编的常量）；② 排序**确定**（同毫秒创建时有 id 作次级键，
   * 否则断言会偶发失败 —— "看起来像 flaky，其实是排序不确定"）；
   * ③ **列表里不出现材料正文与图谱内容** —— 这是"只回摘要"那条口径唯一的可执行证据。
   */
  const SECRET = '讲义原文里的独特字样-ZZQ-不应出现在列表里';

  clearSessions();
  check('★ 空 store 时列表是空数组（不是 null、也不抛错）', listSessionSummaries().length === 0);

  const first = createSession();
  commitMaterials(first.id, [material('m1', SECRET)], 0, {
    nodes: [point('derivative')],
    edges: [],
  });
  const second = createSession();

  const summaries = listSessionSummaries();
  check('两个会话都在列表里', summaries.length === 2);
  check(
    '★ 摘要有全部约定字段（缺一个前端就渲染不出那一行）',
    ['id', 'createdAt', 'updatedAt', 'materialVersion', 'materialCount'].every(
      (key) => summaries[0][key] !== undefined,
    ),
  );

  const withMaterial = summaries.find((item) => item.id === first.id);
  check('★ 材料份数取自真实会话（1 份）', withMaterial?.materialCount === 1);
  check('材料版本随提交递增（1）', withMaterial?.materialVersion === 1);
  check(
    '★ 轻路径会话报 0 份材料（AI 补充块不计入"学生材料"）',
    summaries.find((item) => item.id === second.id)?.materialCount === 0,
  );

  check(
    '★★ 列表里**不出现材料正文**（"只回摘要"的唯一可执行证据）',
    !JSON.stringify(summaries).includes(SECRET),
  );
  check(
    '★★ 列表里也不出现图谱内容（同一口径的另一半）',
    !JSON.stringify(summaries).includes('derivative'),
  );

  const again = listSessionSummaries();
  check(
    '★ 排序确定：同一状态连查两次顺序一致（否则断言会偶发失败）',
    JSON.stringify(again.map((item) => item.id)) === JSON.stringify(summaries.map((item) => item.id)),
  );
  check(
    '★ 最近变更的排在前面（`updatedAt` 倒序）',
    summaries[0].updatedAt >= summaries[1].updatedAt,
  );
}

/* ==================== 汇总 ==================== */

/* ==================== 14. 概念别名归一（P-B12，2026-09-23） ==================== */

console.log('\n=== 14. 概念别名归一：同义合并 / 边重指 / 自环清除 / 不越界 ===\n');

{
  /* ① 明确同义（导数／微商）→ 合成一个节点，留下先出现的那个 id */
  const synonyms = {
    points: [point('kp-derivative', { name: '导数' }), point('kp-micro', { name: '微商' })],
    prerequisites: [],
    graph: { edges: [] },
  };
  const mergedOne = await analyzeKnowledge(fakeCall(synonyms), { materials: [] });
  check(
    '★ 同义概念（导数／微商）合并为一个节点',
    mergedOne.graph.nodes.length === 1,
    mergedOne.graph.nodes.length,
  );
  check(
    '★ 留下的是**先出现**的那个（id 由模型给，顺序就是唯一可依赖的信息）',
    mergedOne.graph.nodes[0]?.id === 'kp-derivative',
    mergedOne.graph.nodes[0]?.id,
  );

  /* ② 书写形式差异（空格 / 大小写 / 全角括号）也归一到一起 */
  const spacing = {
    points: [point('a', { name: '洛必达法则' }), point('b', { name: ' 洛必达法则 ' })],
    prerequisites: [],
    graph: { edges: [] },
  };
  const spaced = await analyzeKnowledge(fakeCall(spacing), { materials: [] });
  check('★ 只差空格／大小写的同名概念合并为一个', spaced.graph.nodes.length === 1);
  check('★ 合并后**不改名**（保留先出现那个的原文）', spaced.graph.nodes[0]?.name === '洛必达法则');

  /* ③ 边重指：入边与出边都要改指到主 id */
  const withEdges = {
    points: [point('kp-derivative', { name: '导数' }), point('kp-micro', { name: '微商' })],
    prerequisites: [],
    graph: {
      edges: [edge('kp-monotonicity', 'kp-micro'), edge('kp-micro', 'kp-limit')],
    },
  };
  const rewired = await analyzeKnowledge(fakeCall(withEdges), { materials: [] });
  const pairs = rewired.graph.edges.map((item) => `${item.from}->${item.to}`);
  check(
    '★ 指向被合并 id 的边改指到主 id',
    pairs.includes('kp-monotonicity->kp-derivative'),
    pairs.join(' , '),
  );
  check('★ 从被合并 id 出发的边也改指', pairs.includes('kp-derivative->kp-limit'), pairs.join(' , '));
  check(
    '★ 图里不再出现被合并的 id（否则缺口判定会重复）',
    !JSON.stringify(rewired.graph).includes('kp-micro'),
  );

  /* ④ 合并**产生**的自环必须消失 —— 这条专锁归一顺序 */
  const selfLoop = {
    points: [point('kp-derivative', { name: '导数' }), point('kp-micro', { name: '微商' })],
    prerequisites: [],
    graph: { edges: [edge('kp-derivative', 'kp-micro')] },
  };
  const deduped = await analyzeKnowledge(fakeCall(selfLoop), { materials: [] });
  check(
    '★★ 合并产生的自环被去掉（顺序必须是：先合并 → 再删自环 → 最后排环）',
    deduped.graph.edges.length === 0,
    deduped.graph.edges.length,
  );

  /* ⑤ 反例：**不同义**的不许合并（防"过度归一"造出不存在的概念） */
  const distinct = {
    points: [
      point('kp-derivative', { name: '导数' }),
      point('kp-differential', { name: '微分' }),
      point('kp-integral', { name: '积分' }),
      point('kp-partial', { name: '偏导数' }),
    ],
    prerequisites: [],
    graph: { edges: [] },
  };
  const notMerged = await analyzeKnowledge(fakeCall(distinct), { materials: [] });
  check(
    '★★ 不同义的概念**不**合并（导数／微分／积分／偏导数 仍是 4 个节点）',
    notMerged.graph.nodes.length === 4,
    notMerged.graph.nodes.length,
  );

  /* ⑥ 英文名与中文名同义时合并 */
  const bilingual = {
    points: [point('p1', { name: 'derivative' }), point('p2', { name: '导数' })],
    prerequisites: [],
    graph: { edges: [] },
  };
  const mergedBilingual = await analyzeKnowledge(fakeCall(bilingual), { materials: [] });
  check('★ 英文名与中文名同义时也合并', mergedBilingual.graph.nodes.length === 1);
}

/* ==================== 15. 错题归因（P-B9，2026-09-23） ==================== */

console.log('\n=== 15. 错题归因：四类各有可复现样例，理由逐条可核 ===\n');

{
  const allItems = Object.values(FIXED_QUIZ).flat();
  const distractors = allItems.flatMap((item) =>
    item.options
      .filter((option) => option.id !== item.answer)
      .map((option) => ({ item, option })),
  );

  /* ① 标注表本身：齐不齐、键对不对得上、有没有标错地方 */
  check('自编题共 9 道（3 主题 × 3 道）', allItems.length === 9, String(allItems.length));
  check(
    '★ 27 个干扰项**全部**带错因标注，无一遗漏',
    distractors.length === 27 && distractors.every(({ option }) => option.misconception),
    `缺失 ${distractors.filter(({ option }) => !option.misconception).length} 条 / 共 ${distractors.length}`,
  );

  /* 键写错（如把 fx-der-1 拼成 fx-der-01）会让标注**静默失效** —— 标注在表里、
     题目上却没有，归因于是退化。这里把它变成红灯。 */
  const hitKeys = allItems
    .flatMap((item) => item.options.map((option) => misconceptionKey(item.id, option.id)))
    .filter((key) => key in FIXED_QUIZ_MISCONCEPTIONS);
  check(
    '★★ 标注表的 27 个键全部命中真实选项（拼错键会静默失效）',
    hitKeys.length === 27,
    `命中 ${hitKeys.length}，表内共 ${Object.keys(FIXED_QUIZ_MISCONCEPTIONS).length} 条`,
  );
  check(
    '★ 正确选项上**没有**错因标注（标注只能描述"错在哪"）',
    allItems.every((item) => !item.options.find((o) => o.id === item.answer)?.misconception),
  );

  const kindsUsed = new Set(distractors.map(({ option }) => option.misconception?.kind));
  check(
    '★ 四类归因在自编题里都有可复现样例',
    ATTRIBUTABLE_KINDS.every((kind) => kindsUsed.has(kind)),
    `实际出现：${[...kindsUsed].join(' / ')}`,
  );
  check(
    '错因理由都是可核对的实句（均 > 20 字，不是"理解不到位"式空话）',
    distractors.every(({ option }) => (option.misconception?.reason.length ?? 0) > 20),
  );

  /* ② 四类各挑一条走完整条链路 */
  const SAMPLES = [
    ['fx-der-1', 'A', 'concept-misunderstanding', '把函数值当导数值'],
    ['fx-der-1', 'D', 'calculation-error', '把 2x 取成了倒数'],
    ['fx-der-3', 'A', 'condition-omission', '漏掉"在 x = 2 处"'],
    ['fx-der-2', 'A', 'recognition-error', '把 Δx→0 当成了结果为 0'],
  ];
  for (const [itemId, optionId, expectedKind, what] of SAMPLES) {
    const item = allItems.find((it) => it.id === itemId);
    const attribution = attributeQuizAttempt({ item, selectedOptionId: optionId });
    check(
      `★ 样例：${itemId} 选 ${optionId} ⇒ ${expectedKind}（${what}）`,
      attribution?.kind === expectedKind,
      attribution ? attribution.kind : '返回了 null',
    );
    check(
      `   ${itemId}:${optionId} 的依据是预标注、可信度为人工核验（basis/verification 如实回报）`,
      attribution?.basis === 'option-tag' && attribution?.verification === 'human',
      `${attribution?.basis} / ${attribution?.verification}`,
    );
    /* 核对材料必须两侧齐全且不同 —— 这是"可核对"的物理下限 */
    check(
      `   ${itemId}:${optionId} 带齐两侧原文证据（学生可比对）`,
      Boolean(
        attribution?.evidence?.selectedText &&
          attribution?.evidence?.correctText &&
          attribution.evidence.selectedText !== attribution.evidence.correctText,
      ),
    );
  }

  /* ③ 答对／选项不存在 ⇒ 不给归因（不无中生有） */
  const der1 = allItems.find((it) => it.id === 'fx-der-1');
  check(
    '答对时不归因（归因只描述"错在哪"）',
    attributeQuizAttempt({ item: der1, selectedOptionId: 'B' }) === null,
  );
  check(
    '选了不存在的选项 ⇒ 返回 null（给不出证据就不给结论）',
    attributeQuizAttempt({ item: der1, selectedOptionId: 'Z' }) === null,
  );

  /* ④ 强断言：27 个干扰项**逐条**都能归因，一条都不许落到"无法归因" */
  const unresolved = distractors.filter(
    ({ item, option }) => attributeQuizAttempt({ item, selectedOptionId: option.id }) === null,
  );
  check(
    '★★ 自编题的 27 个干扰项全部能给出归因（自己出的题没有理由推不出来）',
    unresolved.length === 0,
    unresolved.map(({ item, option }) => `${item.id}:${option.id}`).join(', '),
  );
}

/* ---------- 层 ②：结构推导（无预标注时按集合关系归因） ---------- */

console.log('\n--- 15.2 结构推导层：只用可复算的集合关系，推不出就不断言 ---\n');

{
  /* 合成一道**没有预标注**的区间题 —— 层 ① 拿不到，才能测到层 ② */
  const intervalItem = {
    id: 'syn-mon-1',
    topic: 'monotonicity',
    source: 'material',
    stem: '（合成题）函数 f 的单调递增区间是：',
    options: [
      { id: 'A', text: '(−∞, −1) 与 (1, +∞)' },
      { id: 'B', text: '(1, +∞)' },
      { id: 'C', text: '(−∞, +∞)' },
      { id: 'D', text: '(−1, 1)' },
    ],
    answer: 'A',
  };

  const subset = attributeQuizAttempt({ item: intervalItem, selectedOptionId: 'B' });
  check(
    '★ 所选区间是正确答案的**真子集** ⇒ 条件遗漏（一次包含判定，可复算）',
    subset?.kind === 'condition-omission',
    String(subset?.kind),
  );
  check(
    '   该归因的依据是结构推导、可信度是符号推导（**不冒充**人工标注）',
    subset?.basis === 'structural' && subset?.verification === 'symbolic',
    `${subset?.basis} / ${subset?.verification}`,
  );
  check(
    '   理由说的是"答案本身的集合关系"，可当场核对',
    Boolean(subset?.reason.includes('真子集')),
    subset?.reason,
  );

  const superset = attributeQuizAttempt({ item: intervalItem, selectedOptionId: 'C' });
  check(
    '★ 所选区间**多包含**了一部分 ⇒ 条件遗漏，且理由与"子集"那条**不同**',
    superset?.kind === 'condition-omission' &&
      superset.reason !== subset?.reason &&
      superset.reason.includes('多包含'),
    superset?.reason,
  );

  /* 关键红线：两个区间**不相交**时分不开"概念混了"与"看错了题" ⇒ 不许猜 */
  check(
    '★★ 所选区间与正确答案不相交 ⇒ 返回 null（分不开就不断言，§2.6）',
    attributeQuizAttempt({ item: intervalItem, selectedOptionId: 'D' }) === null,
  );

  /* 关键红线：**数值**型选项不做倍数／反号推断 —— 这是被否决的一层（见 attribution.ts） */
  const numericItem = {
    id: 'syn-num-1',
    topic: 'derivative',
    source: 'material',
    stem: '（合成题）f′(2) = ：',
    options: [
      { id: 'A', text: '12' },
      { id: 'B', text: '6' },
      { id: 'C', text: '24' },
    ],
    answer: 'A',
  };
  check(
    '★★ 无标注的数值题选错 ⇒ 如实返回"无法归因"，不按倍数/反号关系猜（被否决的数值层）',
    attributeQuizAttempt({ item: numericItem, selectedOptionId: 'B' }) === null,
  );
}

/* ---------- 关键反例：这条把"被否决的数值层"钉死 ---------- */

console.log('\n--- 15.3 反例：数值倍数关系**不足以**断定计算错误 ---\n');

{
  /* `fx-der-3` 的正确答案是 12、干扰项 A 是 6。
     一个天真的实现会说"6 正好是 12 的一半 ⇒ 计算错误（除以 2）"，
     但选 6 的真实原因是**忘了把 x = 2 代进去**（6 是导函数 f′(x) = 6x 的系数）。
     这个反例就是**删掉数值层**的依据，保留在此防止后来者把它加回来。 */
  const der3 = Object.values(FIXED_QUIZ)
    .flat()
    .find((item) => item.id === 'fx-der-3');
  const attribution = attributeQuizAttempt({ item: der3, selectedOptionId: 'A' });
  check(
    '★★ 反例：fx-der-3 选 6 ⇒ 归为「条件遗漏」，**不是**"除以 2 算错"',
    attribution?.kind === 'condition-omission',
    String(attribution?.kind),
  );
  check(
    '★★ 该理由点明了漏掉的条件（x = 2），而不是拿 6 与 12 的倍数关系说事',
    Boolean(attribution?.reason.includes('x = 2') && !attribution.reason.includes('一半')),
    attribution?.reason,
  );
}

/* ==================== 16. 多智能体协作与降级（P-B8，2026-09-23） ==================== */

console.log('\n=== 16. 多智能体降级：任一 Agent 失败不影响主流程并如实标注（E18） ===\n');

{
  const blocks = [
    { id: 'b1', kind: 'explanation', text: '导数是变化率。', verification: 'symbolic' },
  ];
  const events = [
    { type: 'question-asked', sessionId: 's', at: new Date().toISOString(), payload: {} },
  ];

  /* ---------- ① 一切正常：没有降级记录，验证状态原样 ---------- */
  const happy = await orchestrateTutor({
    tutor: async () => blocks,
    verifier: () => 'symbolic',
    diagnoser: () => events,
  });
  check('全部成功时**没有**降级记录（不无端报警）', happy.degraded.length === 0, happy.degraded);
  check('全部成功时验证状态原样透出', happy.verification === 'symbolic');
  check('全部成功时画像事件原样透出', happy.profileEvents.length === 1);

  /* ---------- ② 验证 Agent 失败：主流程继续，且**降级方向只能是更保守** ---------- */
  let verifierErrorSeen = null;
  const verifierDown = await orchestrateTutor(
    {
      tutor: async () => blocks,
      verifier: () => {
        throw new Error('symbolic engine unavailable: ENOENT /internal/path');
      },
      diagnoser: () => events,
    },
    { onAgentError: (agent, error) => (verifierErrorSeen = { agent, message: error.message }) },
  );
  check(
    '★★ 验证 Agent 失败时**主流程继续**（回答块照常返回）',
    verifierDown.blocks.length === 1,
    verifierDown.blocks.length,
  );
  check(
    '★★ 验证 Agent 失败 ⇒ 标 unverified（**绝不**放行成 symbolic/verified）',
    verifierDown.verification === 'unverified',
    verifierDown.verification,
  );
  check(
    '★★ 失败被**如实标注**：degraded 里有一条 verifier',
    verifierDown.degraded.length === 1 && verifierDown.degraded[0].agent === 'verifier',
    verifierDown.degraded,
  );
  check(
    '   降级记录说清了"为什么"与"改用了什么"（两项都不为空）',
    Boolean(verifierDown.degraded[0].reason) && Boolean(verifierDown.degraded[0].fallback),
  );
  check(
    '★★ 面向学生的文案**不含上游报错原文**（内部路径不外泄）',
    !JSON.stringify(verifierDown.degraded).includes('ENOENT') &&
      !JSON.stringify(verifierDown.degraded).includes('/internal/'),
    JSON.stringify(verifierDown.degraded),
  );
  check(
    '   原始错误只经 onAgentError 交出（给日志，不给界面）',
    verifierErrorSeen?.agent === 'verifier' && verifierErrorSeen.message.includes('ENOENT'),
    verifierErrorSeen,
  );
  check(
    '★ 一个 Agent 失败**不影响别的 Agent**：诊断照常产出',
    verifierDown.profileEvents.length === 1,
  );

  /* ---------- ③ 诊断 Agent 失败：不阻断答疑 ---------- */
  const diagnoserDown = await orchestrateTutor({
    tutor: async () => blocks,
    verifier: () => 'symbolic',
    diagnoser: () => {
      throw new Error('store write failed');
    },
  });
  check('★ 诊断 Agent 失败时答疑照常（回答块在）', diagnoserDown.blocks.length === 1);
  check(
    '★ 诊断 Agent 失败 ⇒ 验证状态**不受连累**（仍是 symbolic）',
    diagnoserDown.verification === 'symbolic',
    diagnoserDown.verification,
  );
  check(
    '★ 诊断 Agent 失败 ⇒ 画像事件为空（跳过更新，而不是记半条）',
    diagnoserDown.profileEvents.length === 0,
  );
  check(
    '★ 诊断 Agent 失败同样被如实标注',
    diagnoserDown.degraded.length === 1 && diagnoserDown.degraded[0].agent === 'diagnoser',
  );

  /* ---------- ④ 两个辅助 Agent 一起挂：两条记录，互不覆盖 ---------- */
  const bothDown = await orchestrateTutor({
    tutor: async () => blocks,
    verifier: () => {
      throw new Error('v');
    },
    diagnoser: () => {
      throw new Error('d');
    },
  });
  check(
    '★★ 两个辅助 Agent 同时失败 ⇒ **两条**降级记录（不互相覆盖、不合并成一条）',
    bothDown.degraded.length === 2 &&
      bothDown.degraded.map((item) => item.agent).sort().join(',') === 'diagnoser,verifier',
    bothDown.degraded.map((item) => item.agent),
  );

  /* ---------- ⑤ 主 Agent（答疑）失败：**照常抛出**，不吞 ---------- */
  let mainThrew = false;
  try {
    await orchestrateTutor({
      tutor: async () => {
        throw new Error('main agent down');
      },
      verifier: () => 'symbolic',
    });
  } catch {
    mainThrew = true;
  }
  check(
    '★★ 答疑 Agent 失败时**抛出**（它就是主流程，没有可降级的替身；吞掉等于给"成功但空"的响应）',
    mainThrew,
  );

  /* ---------- ⑥ 没注入验证 Agent ⇒ 缺省 unverified，但**不算降级** ---------- */
  const noVerifier = await orchestrateTutor({ tutor: async () => blocks });
  check(
    '★ 未接入验证 Agent 时缺省 unverified（§4.2 失败安全方向）',
    noVerifier.verification === 'unverified',
    noVerifier.verification,
  );
  check(
    '★★ "没有这个 Agent"与"这个 Agent 失败了"**分开**：不产生降级记录',
    noVerifier.degraded.length === 0,
    noVerifier.degraded,
  );
}

/* ---------- 16.2 出题 Agent 失败 ⇒ 回落到固定题 ---------- */

console.log('\n--- 16.2 出题 Agent 失败 ⇒ 回落到固定题（并改口来源） ---\n');

{
  const generated = [
    { id: 'g1', topic: 'derivative', source: 'material', stem: '按材料生成的题', options: [], answer: 'A' },
  ];
  const fixed = [
    { id: 'fx-der-1', topic: 'derivative', source: 'fixed', stem: '自编题', options: [], answer: 'B' },
  ];

  const ok = await orchestrateQuiz(async () => generated, () => fixed);
  check('出题成功时用生成题，且无降级记录', ok.items[0].id === 'g1' && ok.degraded.length === 0);

  const fell = await orchestrateQuiz(
    async () => {
      throw new Error('quizzer down');
    },
    () => fixed,
  );
  check('★ 出题 Agent 失败 ⇒ 回落到固定题（§4.5）', fell.items[0].id === 'fx-der-1', fell.items);
  check(
    '★★ 回落被如实标注（degraded 里一条 quizzer）',
    fell.degraded.length === 1 && fell.degraded[0].agent === 'quizzer',
    fell.degraded,
  );
  check(
    '★ 回落的说明指出"题不是按你的材料生成的"（否则就是冒名，§9）',
    fell.degraded[0].fallback.includes('不是根据你的材料生成'),
    fell.degraded[0].fallback,
  );

  /* 出题"成功"但返回空 —— 对学生同样无用，也该回落 */
  const empty = await orchestrateQuiz(async () => [], () => fixed);
  check(
    '★ 出题成功但返回**空集** ⇒ 也回落到固定题（空题等于没有题）',
    empty.items[0].id === 'fx-der-1',
    empty.items,
  );
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
