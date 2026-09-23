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

async function call(method, path, body, extraHeaders) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: await res.json().catch(() => null),
    /* 响应头也带出来：账号那节要断言"没有 Set-Cookie"（⇒ 不存在 CSRF 面） */
    headers: [...res.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n'),
  };
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
/*
 * `unavailable` 是**能力级**字段（"这条通道接没接"），不是"本次有没有识别出东西"。
 *
 * 纯文字输入：语音这次没发（服务端确实不转写）、公式也不是未接入的通道（图片路径已接）
 * ⇒ **一项都不该有**，字段整个不出现。
 *
 * ⚠️ 2026-09-22 修正前，这里断言的是 `parsed.unavailable.includes('formula')`
 * —— 等于把"纯文字必然误报公式未接入"锁进了测试，所以它一直是绿的。
 * 教训：断言要写**应该成立的口径**，不要照抄当时的实现行为。
 */
check(
  '②a 纯文字输入不误报「未接入」（公式是能力已接，语音这次也没发）',
  (parsed.unavailable ?? []).length === 0,
  parsed.unavailable,
);

/* ②a′ 反面用例：本次**真的**带了语音（服务端确实不转写）⇒ 必须如实列出 audio */
const withAudio = (
  await call('POST', '/api/parse', { text: '这段材料配了一段语音说明。', audioBase64: 'ZmFrZQ==' })
).json;
check(
  '②a′ 本次带了语音 ⇒ 如实列出 audio（服务端不转写，是硬事实）',
  Array.isArray(withAudio.unavailable) && withAudio.unavailable.includes('audio'),
  withAudio.unavailable,
);
check(
  '②a′ 且**只**列 audio —— 公式永不出现在「未接入」里（能力 ≠ 结果）',
  JSON.stringify(withAudio.unavailable) === JSON.stringify(['audio']),
  withAudio.unavailable,
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
/*
 * `I1`（卡 0-4）：**关系边必须真的走通"产出 → 落盘 → 读回"**。
 *
 * 此前 mock 不产出 `edges`，所以这条路径是空的；也正因为空，
 * 后面 ⑦ 那条 `graphAfter.edges.length === 0 || …` 的写法会**恒真**
 * （这正是本项目吃过亏的"判据失去分辨力"）。
 * 这里补上正面路径：读回来的边数 = 落盘的边数，且**确实 > 0**。
 */
check(
  '③ GET /api/graph → 关系边也读得回（I1 落地前这里恒为 0 条）',
  graph.edges.length > 0 && graph.edges.length === knowledge.graph.edges.length,
  graph.edges.map((item) => `${item.from}->${item.to}`).join(', '),
);

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
/*
 * `B3` 落地后（2026-09-20）：mock 的补充内容带与说明书 §7.1 一致的 `claims`，
 * 于是状态**真的**走到 `VERIFIED` —— 这就是 `P-B2` 要求的
 * `MISSING → SUPPLEMENTED → VERIFIED` 可达性，端到端跑通。
 *
 * ⚠️ 这三条在 `B3` 之前写的是 `SUPPLEMENTED` / `unverified`。那种写法编码的是
 * "引擎还没做"的旧状态，不是能力本身 —— 引擎一接上它们必然变红。
 * 改的是**期望值**（跟着真实行为走），不是放宽判据。
 */
check('⑥ 补充成功 → 状态 VERIFIED（claims 通过符号校验）', gap.status === 'VERIFIED', gap.status);
check('⑥ 验证状态为 symbolic（符号引擎已接入，B3）', gap.verification === 'symbolic', gap.verification);
check('⑥ 版本递增到 2', gap.materialVersion === 2);
check('⑥ 返回补充块 ID', typeof gap.supplementBlockId === 'string');
check('⑥ 补充内容明显是一段说明（非空）', gap.content.length > 50, gap.content?.length);
// `I18`：`SUPPLEMENT_LENGTH`（200—400 字，按非空白字符计）已接线
const gapLength = Array.from(gap.content).filter((char) => !/\s/.test(char)).length;
check(
  '⑥ 补充长度落在 SUPPLEMENT_LENGTH 区间内（I18 接线）',
  gapLength >= 200 && gapLength <= 400,
  `${gapLength} 字`,
);

/* 7. 补充后图谱的入边应转为 VERIFIED（与 gap.status 同一个口径） */
const graphAfter = (await call('GET', `/api/graph?sessionId=${session.id}`)).json;
const touched = graphAfter.edges.filter((e) => e.to === gapConcept);
check(
  '⑦ 图谱入边已转 VERIFIED',
  graphAfter.edges.length === 0 || touched.every((e) => e.status === 'VERIFIED'),
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
/*
 * `I16`：重放的**状态**必须从图谱实况读。原先那条路径硬编码 `status: 'SUPPLEMENTED'` ——
 * 概念已经是 `VERIFIED` 时却回"已补充"，是低报（也自相矛盾）。
 */
check('⑧ 重放状态仍为 VERIFIED（I16：不再硬编码 SUPPLEMENTED）', again.status === 'VERIFIED', again.status);
check('⑧ 重放验证状态仍为 symbolic', again.verification === 'symbolic', again.verification);

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

/*
 * 10b. 提交练习 → 错题归因（`P-B9`，2026-09-23）
 *
 * 这一段走的是**真实 HTTP**，因此覆盖的是整条链的最后一环：
 * 请求 → 服务端按 itemId 反查题库 → 判分 → 归因 → 写画像 → 回传逐题结论。
 * 归因判据本身在 `verify:graph` 的 §15 里离线覆盖（那边能测到 27 个干扰项）。
 *
 * 这里的重点有两个，都是**离线测不出来**的：
 * ① 同一个坑在**不同题目**上踩两次，画像里的 `count` 必须累到 2
 *    （这才叫"常见误区"，否则画像只是一串各说各话的句子）；
 * ② 题库里没有的题（按材料生成的）**不许**被编出一个错因。
 */
const monItems = fixed.items;
const wrong1 = monItems.find((i) => i.id === 'fx-mon-1');
const wrong3 = monItems.find((i) => i.id === 'fx-mon-3');
const right2 = monItems.find((i) => i.id === 'fx-mon-2');
check('⑩b 自编主题题齐备（fx-mon-1/2/3）', Boolean(wrong1 && wrong3 && right2));

/* 两道错题：fx-mon-1 选 A、fx-mon-3 选 B —— 都是"把导数符号与单调性对应关系记反" */
const attempt = (
  await call('POST', '/api/quiz/attempt', {
    sessionId: session.id,
    answers: [
      { itemId: 'fx-mon-1', selectedOptionId: 'A' },
      { itemId: 'fx-mon-3', selectedOptionId: 'B' },
      { itemId: 'fx-mon-2', selectedOptionId: 'B' },
    ],
  })
).json;

check('⑩b 提交返回逐题结果（3 条）', attempt?.results?.length === 3, attempt?.results?.length);
check(
  '⑩b 判分在服务端完成：fx-mon-2 选 B 判对，另两题判错',
  attempt.results.find((r) => r.itemId === 'fx-mon-2')?.correct === true &&
    attempt.results.filter((r) => !r.correct).length === 2,
);

const a1 = attempt.results.find((r) => r.itemId === 'fx-mon-1')?.attribution;
const a3 = attempt.results.find((r) => r.itemId === 'fx-mon-3')?.attribution;
check(
  '⑩b 两道错题都给出了归因（概念误解），不是 null',
  a1?.kind === 'concept-misunderstanding' && a3?.kind === 'concept-misunderstanding',
  `${a1?.kind} / ${a3?.kind}`,
);
check(
  '⑩b 归因带**可核对的证据**（学生选的原文 vs 正确原文，两侧都在）',
  Boolean(a1?.evidence?.selectedText && a1?.evidence?.correctText),
  a1?.evidence,
);
check(
  '⑩b 归因依据如实标为「干扰项预标注」（basis/verification 不夸大）',
  a1?.basis === 'option-tag' && a1?.verification === 'human',
  `${a1?.basis} / ${a1?.verification}`,
);
check(
  '⑩b 答对的那题**不归因**（归因只描述"错在哪"）',
  attempt.results.find((r) => r.itemId === 'fx-mon-2')?.attribution === null,
);
check('⑩b 没有推不出来的错题（unattributed = 0）', attempt.unattributed === 0);

/*
 * ★★ 本段的核心断言：**跨题累计**。
 * 两道题不属于同一题号，但属于**同一个坑** ⇒ 画像里应当只有 1 条、count = 2。
 * 若 `pattern` 写成了逐题各异的句子，这里会变成两条 count = 1 —— 那就是
 * "画像记了一堆各说各话的话，却数不出学生反复踩的是哪个坑"。
 */
const samePattern = attempt.profile.misconceptions.filter(
  (m) => m.pattern === a1?.pattern && m.kind === 'concept-misunderstanding',
);
check(
  '⑩b ★★ 同一个坑在不同题目上累加到同一条（count = 2，不是两条 count = 1）',
  attempt.profile.misconceptions.length === 1 && samePattern[0]?.count === 2,
  attempt.profile.misconceptions,
);

/* 再提交一次同样的错法 ⇒ 累计继续涨（画像不是"最后一笔覆盖"） */
const again2 = (
  await call('POST', '/api/quiz/attempt', {
    sessionId: session.id,
    answers: [{ itemId: 'fx-mon-1', selectedOptionId: 'A' }],
  })
).json;
check(
  '⑩b 重复踩同一个坑 → count 继续累加（3）',
  again2.profile.misconceptions[0]?.count === 3,
  again2.profile.misconceptions,
);

/*
 * ★★ 诚实性：题库里没有的题**不许**被编出错因。
 * `not-in-bank-1` 模拟按材料/变式生成的题（服务端不持有它们）。
 */
const unknown = (
  await call('POST', '/api/quiz/attempt', {
    sessionId: session.id,
    answers: [{ itemId: 'not-in-bank-1', selectedOptionId: 'A' }],
  })
).json;
check(
  '⑩b ★★ 题库外的题不编错因：attribution 为 null 且计入 unattributed',
  unknown.results[0]?.attribution === null && unknown.unattributed === 1,
  unknown.results[0],
);
check(
  '⑩b 题库外的题不被计入画像「常见误区」（没有依据就不写）',
  unknown.profile.misconceptions.reduce((sum, m) => sum + m.count, 0) === 3,
  unknown.profile.misconceptions,
);

/*
 * 参数校验：会话不存在要**明确报错**，不能静默成功。
 *
 * 口径与其余接口一致（`requireSession` → `SESSION_NOT_FOUND` → 404）：
 * 这是"你指的会话不存在"，不是"你的请求写错了"（那才是 400）。
 */
const badAttempt = await call('POST', '/api/quiz/attempt', {
  sessionId: 'no-such-session',
  answers: [{ itemId: 'fx-mon-1', selectedOptionId: 'A' }],
});
check('⑩b 会话不存在 → 404（与其它接口口径一致，不静默成功）', badAttempt.status === 404, badAttempt.status);


/* 11. 轻路径（不建会话） */
const light = (
  await call('POST', '/api/tutor', { sessionId: null, materialVersion: 0, question: '什么是切线？', mode: 'explain' })
).json;
check('⑪ 轻路径（sessionId=null）可答疑', Array.isArray(light.blocks) && light.blocks.length > 0);
check('⑪ 轻路径标注未基于材料', light.basedOnMaterial === false);

/*
 * 10c. 降级字段的**线上形状**（`P-B8`，E18）
 *
 * 【为什么这条排在⑪之后而不是⑩旁边】本段要同时看「有材料」「轻路径」「固定题」
 * 三种正常响应的形状，其中轻路径的 `light` 在⑪才声明。放在⑩的位置会撞上
 * `const` 的暂时性死区（TDZ）—— 第一版就是这么写的，跑起来直接 `ReferenceError`。
 * 断言顺序服从数据依赖，不为了让编号好看而重排声明。
 *
 * 【这条只能在这里测什么】`degraded` 的**取值分支**由 `verify:graph` §16 用
 * **注入的假 Agent** 覆盖（那边能构造任意一个 Agent 挂掉）；而"一切正常时这个字段
 * **不出现**"是关于真实响应体的约定 —— 契约写明它"缺省即没有异常，不必到处写空数组"。
 * 两处合起来才构成完整结论：异常时必出现、正常时不出现。
 *
 * ⚠️ **如实说明本段测不到什么**：`MODEL_PROVIDER=mock` 的假模型
 * **没有失败注入开关**，因此"真实 HTTP 上一次 Agent 失败后仍能拿到降级标注"
 * 这条端到端路径**在这里验不了**。它目前只由 §16 的离线注入覆盖。
 * 不为了凑绿而给 mock 加一个只有测试用的失败开关 —— 那会让"降级路径已验证"
 * 这句话变得含糊（验证的是开关，不是真实故障）。
 */
check(
  '⑩c 一切正常时响应里**不带** degraded（契约：缺省即无异常）',
  !('degraded' in generated) && !('degraded' in light) && !('degraded' in fixed),
  { generated: 'degraded' in generated, light: 'degraded' in light, fixed: 'degraded' in fixed },
);

/* 12. 跨会话隔离（用例 E10） */
const other = (await call('POST', '/api/session')).json;
const otherGraph = (await call('GET', `/api/graph?sessionId=${other.id}`)).json;
check('⑫ 新会话读不到上一会话的图谱（E10）', otherGraph.nodes.length === 0 && otherGraph.edges.length === 0);

/*
 * 13. I13：**有会话但零材料**时提问，不得被误判为 `UNAUTHORIZED_CONTENT`。
 *
 * 这是本轮补上的断言，也是"334 项全绿 ≠ 没有缺陷"的样例：
 * 修复前这一路径稳定返回 403 且 `retryable=false`（学生卡死），
 * 而上面 12 组断言**没有任何一条**经过它 —— 因为每一组要么带材料、要么不带会话。
 * 可达路径：点「开始新学习」或「按我的材料出题」之后再直接提问。
 */
const emptySession = (await call('POST', '/api/session')).json;
const zeroMaterialAsk = await call('POST', '/api/tutor', {
  sessionId: emptySession.id,
  materialVersion: emptySession.materialVersion,
  question: '单调性怎么判断',
  mode: 'explain',
});
check(
  '⑬ 有会话但零材料：提问不被拒（修 I13 前是 403 UNAUTHORIZED_CONTENT）',
  zeroMaterialAsk.status === 200,
  { status: zeroMaterialAsk.status, error: zeroMaterialAsk.json?.error ?? null },
);
check(
  '⑬ 零材料仍如实标注「未基于材料」（有会话不等于有材料）',
  zeroMaterialAsk.json?.basedOnMaterial === false,
  zeroMaterialAsk.json?.basedOnMaterial,
);
check(
  '⑬ 正常回答不带 droppedBlocks（该字段只在确有块被校验丢弃时出现，I14）',
  zeroMaterialAsk.json?.droppedBlocks === undefined,
  zeroMaterialAsk.json?.droppedBlocks ?? null,
);

/*
 * 14. I20⑥：零材料会话「按我的材料出题」必须被拒。
 * 修复前它返回一组写死的题并统一标成 `source: 'material'`，前端据此显示
 * 「基于你的材料生成」—— 来源声明不成立，属真实性红线。
 */
const emptyQuiz = await call('POST', '/api/quiz', {
  topic: 'monotonicity',
  source: 'material',
  sessionId: emptySession.id,
});
check(
  '⑭ 零材料会话按材料出题被拒（400 BAD_REQUEST，不返回 source=material 的题）',
  emptyQuiz.status === 400 && emptyQuiz.json?.error?.code === 'BAD_REQUEST',
  { status: emptyQuiz.status, error: emptyQuiz.json?.error ?? null },
);

/*
 * 15. `I29` / `I31`：**零材料会话 + 一个已授权补充块** 上提问，原先必然 403。
 *
 * 这条路径与上面 13 组**不同**：会话里没有学生材料，但有一个学生点过「补上这一段」
 * 生成的补充块（`/api/gap` 在 `materialVersion 0` 的会话上本就允许成功，是合法状态）。
 * 修复前：mock 恒返回**不带引用**的 `ai-supplement` 块 → 被来源守卫拒（403 且
 * `retryable=false`），学生卡死 —— 正是 `I13` 要消灭的那条死路换了个入口。
 *
 * 根因是 **mock 保真度**（忽略 `supplementIds`），不是守卫过严：
 * 守卫的语义是"回答必须能追溯到真实存在的来源"，无引用即拒。
 */
const supplementSession = (await call('POST', '/api/session')).json;
const filledGap = await call('POST', '/api/gap', {
  sessionId: supplementSession.id,
  materialVersion: 0,
  conceptId: 'kp-derivative',
  reason: '判断单调性依赖导数定义，学生讲义里没有这一段。',
});
check(
  '⑮ 零材料会话上补缺口成功（materialVersion 0 是合法状态）',
  filledGap.status === 200 && typeof filledGap.json?.supplementBlockId === 'string',
  { status: filledGap.status, error: filledGap.json?.error ?? null },
);

const afterGapAsk = await call('POST', '/api/tutor', {
  sessionId: supplementSession.id,
  materialVersion: filledGap.json?.materialVersion ?? 1,
  question: '什么是导数？',
  mode: 'explain',
});
check(
  '⑮ 有已授权补充块时提问不被拒（修 I29/I31 前是 403 UNAUTHORIZED_CONTENT）',
  afterGapAsk.status === 200,
  { status: afterGapAsk.status, error: afterGapAsk.json?.error ?? null },
);
check(
  '⑮ 回答确实引用了那个已授权补充块（mock 保真，I31）',
  afterGapAsk.json?.blocks?.[0]?.citations?.[0]?.refId === filledGap.json?.supplementBlockId,
  afterGapAsk.json?.blocks?.[0]?.citations ?? null,
);
check(
  '⑮ 只有补充块、没有学生材料 → basedOnMaterial 仍为 false（I36）',
  afterGapAsk.json?.basedOnMaterial === false,
  afterGapAsk.json?.basedOnMaterial,
);

/*
 * 16. `I30`：同一会话上 `/api/quiz` 会拒（它只认学生材料），文案必须说清
 * "只有 AI 补充内容、没有你的讲义"，而不是笼统一句"还没有材料"
 * —— 后者会让学生以为会话是空的，去翻一个其实有内容的会话。
 */
const supplementQuiz = await call('POST', '/api/quiz', {
  topic: 'monotonicity',
  source: 'material',
  sessionId: supplementSession.id,
});
check(
  '⑯ 只有补充块时按材料出题被拒，且文案明说「只有 AI 补充内容」（I30）',
  supplementQuiz.status === 400 && /AI 补充内容/.test(supplementQuiz.json?.error?.message ?? ''),
  { status: supplementQuiz.status, message: supplementQuiz.json?.error?.message ?? null },
);

/*
 * 17. `I17`：`/api/health` 的 `version` 必须是**运行时读到的包版本**，
 * 不再是硬编码字符串（原先写死 `'0.2.0'`，而五个 `package.json` 都是 `0.1.0`）。
 */
const healthBody = (await call('GET', '/api/health')).json;
const serverPkgVersion = JSON.parse(
  await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;
check(
  '⑰ health.version 运行时取自 @lc/server 的 package.json（不再硬编码，I17）',
  healthBody?.version === serverPkgVersion,
  { actual: healthBody?.version ?? null, expected: serverPkgVersion },
);

/* ==================== GET /api/sessions（2026-09-23 新增，P2-1） ==================== */

console.log('\n=== 会话列表：列出会话、只回摘要 ===\n');
{
  const list = await call('GET', '/api/sessions');
  check('★ GET /api/sessions → 200', list.status === 200, list.status);
  check('返回 sessions 数组', Array.isArray(list.json.sessions));

  const mine = list.json.sessions.find((item) => item.id === session.id);
  check('★ 提交过材料的会话出现在列表里', mine !== undefined);
  check('★ 材料份数与真实提交一致（1 份）', mine?.materialCount === 1, mine?.materialCount);
  check(
    '材料版本与 GET /api/graph 读回的一致（同一份事实，不各说各话）',
    mine?.materialVersion === graphAfter.materialVersion,
    { list: mine?.materialVersion, graph: graphAfter.materialVersion },
  );

  const empty = list.json.sessions.find((item) => item.id === emptySession.id);
  check(
    '★ 轻路径会话也在列表里，且如实报 0 份材料',
    empty?.materialCount === 0,
    empty?.materialCount,
  );

  check(
    '★★ 列表里不出现材料正文（"只回摘要"的端到端证据）',
    !JSON.stringify(list.json).includes(materialText),
  );
  check(
    '★★ 列表里不出现图谱节点内容',
    !JSON.stringify(list.json).includes(graphAfter.nodes[0]?.id ?? '__no-node__'),
  );
}

/* ==================== 测试材料库（fixtures/materials，2026-09-23） ==================== */

console.log('\n=== 测试材料库：清单可加载、能跑通真实链路 ===\n');
{
  /*
   * 这一节的作用是给 `fixtures/materials/` 一个**真实消费方**：
   * 一个只有"清单与文本"的目录，如果没有任何脚本用它，它迟早会烂掉。
   * 顺手也验证那份"超长材料"**真的**超过单次上限 —— 否则上限那条用例是空跑。
   */
  const { listMaterials, loadMaterialText } = await import('../../../fixtures/materials/load.mjs');

  const list = listMaterials();
  check('★ 清单可读且非空', Array.isArray(list) && list.length >= 8, list.length);
  check(
    '★ 每份都有 id / file / scenario / expect（缺一个就不能当测试材料用）',
    list.every((item) => item.id && item.file && item.scenario && item.expect),
  );
  check(
    '★ id 不重复（重复会让"按 id 取"取错）',
    new Set(list.map((item) => item.id)).size === list.length,
  );

  const longText = loadMaterialText('too-long');
  check(
    '★ 超长材料确实超过单次上限（3000 字）—— 否则上限那条用例是空跑',
    longText.length > 3000,
    longText.length,
  );

  const fixtureSession = (await call('POST', '/api/session')).json;
  const fixtureKnowledge = await call('POST', '/api/knowledge', {
    sessionId: fixtureSession.id,
    materials: [
      {
        id: 'fx-basic',
        kind: 'upload',
        text: loadMaterialText('basic'),
        createdAt: new Date().toISOString(),
      },
    ],
  });
  check('★ 用测试材料能跑通 /api/knowledge', fixtureKnowledge.status === 200, fixtureKnowledge.status);
  check(
    '★ 该材料产出了知识点（不是空结果）',
    Array.isArray(fixtureKnowledge.json?.points) && fixtureKnowledge.json.points.length > 0,
    fixtureKnowledge.json?.points?.length,
  );
  check('★ 材料版本被推进（材料真的落盘了）', fixtureKnowledge.json?.materialVersion === 1);
}

/* ==================== 教学素材（P-B15，2026-09-23） ==================== */

console.log('\n=== 教学素材：图片与语音真的能过线（清单与缺口在 verify:teaching-materials 里离线验）===\n');
{
  /*
   * 这里只留**过线**的那几条：素材是文件系统的事，图片/语音能不能真的走通接口才是这一层的事。
   *
   * 清单形状、「九格填满」、「单调性素材搜不到导数的定义」全部搬去了
   * `verify:teaching-materials`（进 `verify:all` 的离线套装）。**不在这里重复断言同一件事** ——
   * 尤其那条缺口检查：它必须在**每次改动都会跑的离线套装**里，而不是"有没有人刚起了服务端"
   * 才跑的套装里。两边各管一段，改一处不会忘另一处。
   */
  const teaching = await import('../../../fixtures/teaching-materials/load.mjs');

  const imgParse = await call('POST', '/api/parse', {
    imageBase64: teaching.loadImageBase64('derivative-image'),
  });
  check('★ 教学素材的 PNG 被 /api/parse 的图片通道**接受**（200，不是 400）', imgParse.status === 200, imgParse.status);
  check(
    '★ 识别结果里有文本（mock 给的是固定演示数据，**这不代表图被认对了**）',
    typeof imgParse.json?.text === 'string' && imgParse.json.text.length > 0,
  );
  /*
   * ⚠️ 上面两条**只能证明"这张 PNG 通过了魔数嗅探与体积校验"**。
   * mock 通道不看图的内容、永远返回同一段演示数据，所以"图里的抛物线被识别成了抛物线"
   * 这件事**在这里验不了**，要真实模型通道实测（`npm run smoke:model:image`）。
   * 不写一条"识别结果包含 抛物线"的断言来充数 —— 它在 mock 下必红，在真实通道下又
   * 依赖模型措辞，两条路都不是"验证"，是"猜"。
   */

  /*
   * 坏签名必须被拒。**这条是上一条 200 的对照组**：只有"收得下真图、也拒得了假图"，
   * 前面那条才说明"通道真的在校验"，而不是"什么都收"。
   */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const pngPath = fileURLToPath(
    new URL('../../../fixtures/teaching-materials/images/derivative.png', import.meta.url),
  );
  const brokenPng = Buffer.from(readFileSync(pngPath));
  brokenPng[0] = 0x00; // 把 PNG 签名的第一个字节改掉：还是一张"图"，但不再是 PNG
  const rejected = await call('POST', '/api/parse', { imageBase64: brokenPng.toString('base64') });
  check(
    '★★ 签名被破坏的"图"被 400 拒（证明上面那条 200 不是"什么都收"）',
    rejected.status === 400,
    rejected.status,
  );

  /*
   * 语音：只带语音不带文字 → 400，并说明"语音不由服务端转写"。
   * 这是**语音素材只有转写文本、没有音频**这条事实在接口上的落点 ——
   * 哪天服务端真的接了 ASR，这条会红，正好提醒去改素材里的标注。
   *
   * 错误消息在 `json.error.message`（本项目统一的错误体形状），不是 `json.message`：
   * 第一版按后者取，拿到的永远是 undefined（好在是报失败，不是悄悄变成真）。
   */
  const audioParse = await call('POST', '/api/parse', {
    audioBase64: Buffer.from('not-really-audio').toString('base64'),
  });
  const audioMessage = String(audioParse.json?.error?.message ?? '');
  check(
    '★★ 只带语音不带文字 → 400，且说明"语音不由服务端转写"（与 D3）、识别在浏览器侧',
    audioParse.status === 400 && audioMessage.includes('语音不由服务端转写'),
    `${audioParse.status} ${audioMessage.slice(0, 40)}`,
  );
}
/* ==================== GET /api/teacher（P-C11，2026-09-23 由 501 改为已实现） ==================== */

console.log('\n=== 教师视图：班级聚合（只含计数，不反推个人） ===\n');
{
  const teacher = await call('GET', '/api/teacher?classId=demo-class');
  check('★ GET /api/teacher → 200（原先恒 501，本轮实现）', teacher.status === 200, teacher.status);
  check('classId 原样回显（服务端不假装有班级实体）', teacher.json.classId === 'demo-class');
  check(
    '★ 如实报出样本量（是数字，不是编出来的字符串）',
    typeof teacher.json.studentCount === 'number',
    teacher.json.studentCount,
  );
  check(
    '★ 样本量 ≥ 1（本文件此前确实提交过画像事件）',
    teacher.json.studentCount >= 1,
    teacher.json.studentCount,
  );

  check(
    '概念分布是「概念 → 六态计数」的两层结构',
    Object.values(teacher.json.mastery).every((row) =>
      Object.values(row).every((count) => typeof count === 'number'),
    ),
  );
  check(
    '覆盖热力每条都是 {materialId, conceptId, covered:boolean}',
    Array.isArray(teacher.json.coverageHeat) &&
      teacher.json.coverageHeat.every(
        (item) =>
          typeof item.materialId === 'string' &&
          typeof item.conceptId === 'string' &&
          typeof item.covered === 'boolean',
      ),
    teacher.json.coverageHeat?.length,
  );
  check(
    '误区排行按次数倒序（前端要照这个顺序展示）',
    teacher.json.misconceptions.every(
      (item, index) => index === 0 || teacher.json.misconceptions[index - 1].count >= item.count,
    ),
  );

  /*
   * ★★ 用例 E17 的核心：**聚合结果不能反推到任何具体学生**。
   * 判据取"已知的 sessionId 是否出现在响应体里" —— 比"检查有没有叫 name 的字段"实在得多：
   * 后者换个字段名就绕过去了。
   */
  const teacherRaw = JSON.stringify(teacher.json);
  const knownIds = [session.id, emptySession.id, other.id, supplementSession.id];
  check(
    '★★ 响应体里不出现任何 sessionId（脱敏：不能反推到具体学生）',
    knownIds.every((id) => !teacherRaw.includes(id)),
    knownIds.filter((id) => teacherRaw.includes(id)),
  );

  check('缺 classId → 400（入参守卫照常生效）', (await call('GET', '/api/teacher')).status === 400);
  check(
    '换一个 classId 仍返回同一批聚合（演示级"一个班"，与 classId 无关）',
    (await call('GET', '/api/teacher?classId=another')).json.studentCount ===
      teacher.json.studentCount,
  );
}

/* ==================== 账号（演示级，D7 口径；2026-09-23） ==================== */

console.log('\n=== 账号：登录 / 身份 / 登出（演示级） ===\n');
{
  const wrongPassword = await call('POST', '/api/auth/login', {
    username: 'student',
    password: 'not-the-password',
  });
  check(
    '★ 口令错 → 401 UNAUTHORIZED',
    wrongPassword.status === 401 && wrongPassword.json?.error?.code === 'UNAUTHORIZED',
    wrongPassword.status,
  );

  const unknownUser = await call('POST', '/api/auth/login', {
    username: 'nobody-here',
    password: 'demo',
  });
  check(
    '★★ 用户不存在与口令错**返回同一句话**（否则这就是个账号枚举接口）',
    unknownUser.status === 401 &&
      unknownUser.json?.error?.message === wrongPassword.json?.error?.message,
  );

  check(
    '缺字段 → 400（入参守卫照常生效）',
    (await call('POST', '/api/auth/login', { username: 'student' })).status === 400,
  );

  const ok = await call('POST', '/api/auth/login', { username: 'student', password: 'demo' });
  check(
    '★ 正确口令 → 200，返回令牌与账号',
    ok.status === 200 && typeof ok.json?.token === 'string' && ok.json.token.length > 0,
    ok.status,
  );
  check(
    '★ 响应里不含口令字段（不回显输入口令，也没有 password 字段）',
    /* ⚠️ 不能拿 `"demo"` 当特征：`classId` 本来就是 `demo`（与 aggregateClass 同源） */
    !JSON.stringify(ok.json).includes('"password"') &&
      !JSON.stringify(ok.json).includes('not-the-password'),
  );
  check('★ 角色如实返回（student）', ok.json?.account?.role === 'student');
  check(
    '★★ 登录响应**不设 Cookie**（令牌走请求头 ⇒ 不存在 CSRF 面）',
    !/set-cookie/i.test(ok.headers ?? ''),
  );

  const me = await call('GET', '/api/auth/me', undefined, { 'X-LC-Token': ok.json.token });
  check(
    '★ 带令牌读身份 → 200 且 account 非空',
    me.status === 200 && me.json?.account?.username === 'student',
  );
  check(
    '★★ 不带令牌 → **200 且 account 为 null**（"还没登录"是正常状态，不是错误）',
    (await call('GET', '/api/auth/me')).json?.account === null,
  );
  check(
    '★ 乱令牌 → 同样按未登录处理（不报 500）',
    (await call('GET', '/api/auth/me', undefined, { 'X-LC-Token': 'not-a-real-token' })).json
      ?.account === null,
  );

  await call('POST', '/api/auth/logout', undefined, { 'X-LC-Token': ok.json.token });
  check(
    '★ 登出后同一令牌立即失效',
    (await call('GET', '/api/auth/me', undefined, { 'X-LC-Token': ok.json.token })).json
      ?.account === null,
  );

  const teacher = await call('POST', '/api/auth/login', { username: 'teacher', password: 'demo' });
  check('★ teacher 账号角色为 teacher', teacher.json?.account?.role === 'teacher');
  check(
    '★ 两个账号的 classId 一致（与 aggregateClass 的口径同源）',
    teacher.json?.account?.classId === 'demo',
  );
}

/* ==================== 变式题（P-B17，2026-09-23） ==================== */

console.log('\n=== 变式题：按需加强的概念出题 / 零材料也能练 / 无可练时如实返回空集 ===\n');
{
  const variantSession = (await call('POST', '/api/session')).json;

  /* ① 还没有任何学习记录 ⇒ 空题集（且**不该去调模型**） */
  const none = await call('POST', '/api/quiz', {
    topic: 'derivative',
    source: 'variant',
    sessionId: variantSession.id,
  });
  check(
    '★★ 没有任何学习记录时返回**空题集**（不凭空出题）',
    none.status === 200 && none.json?.items?.length === 0,
    none.json?.items?.length,
  );

  /* ② 造一条「已补充但未验证」的弱点（`SUPPLEMENTED` 算弱：未验证不得默认正确） */
  const profiled = await call('POST', '/api/profile', {
    sessionId: variantSession.id,
    events: [
      {
        type: 'gap-supplemented',
        sessionId: variantSession.id,
        conceptId: 'kp-monotonicity',
        at: new Date().toISOString(),
      },
    ],
  });
  check(
    '前置：该概念在画像里落成 SUPPLEMENTED',
    profiled.json?.mastery?.['kp-monotonicity'] === 'SUPPLEMENTED',
    profiled.json?.mastery?.['kp-monotonicity'],
  );

  const variant = await call('POST', '/api/quiz', {
    topic: 'derivative',
    source: 'variant',
    sessionId: variantSession.id,
  });
  check(
    '★ 有弱点后能出变式题',
    variant.status === 200 && variant.json?.items?.length > 0,
    variant.json?.items?.length,
  );
  check(
    '★★ 题目的 source 一律是 variant（来源由服务端定，不由模型自报）',
    variant.json.items.every((item) => item.source === 'variant'),
  );
  check(
    '★ 变式题缺省「未验证」（AI 生成的题不得默认正确，§4.2）',
    variant.json.items.every((item) => item.verification === 'unverified'),
  );

  /*
   * ★★ 题目里不得出现画像信息 —— 变式题的**依据**是个人画像，
   * 但题目本身不该让学生看出"因为你是差生"（与出题提示词第 4 条同一条纪律）。
   */
  check(
    '★★ 题目文本里不出现「画像／薄弱／答错／弱点」这类画像提示',
    !/画像|薄弱|答错|弱点/.test(JSON.stringify(variant.json.items)),
  );

  /* ③ 指定一个**不在画像里**的概念 ⇒ 仍然空集（不为"凑题"硬出） */
  const unknownConcept = await call('POST', '/api/quiz', {
    topic: 'derivative',
    source: 'variant',
    sessionId: variantSession.id,
    conceptIds: ['kp-not-in-profile'],
  });
  check(
    '★★ 指定的概念不在画像里 ⇒ 空集（不硬出题）',
    unknownConcept.json?.items?.length === 0,
    unknownConcept.json?.items?.length,
  );

  /* ④ 变式题**不要求有材料**：这个会话从头到尾没交过讲义 */
  const zeroMaterial = await call('GET', `/api/graph?sessionId=${variantSession.id}`);
  check(
    '★ 上面这些变式题是在**零材料**会话里出的（变式题不依赖材料）',
    zeroMaterial.json?.nodes?.length === 0,
    zeroMaterial.json?.nodes?.length,
  );

  /* ⑤ 枚举扩展后守卫没有放松 */
  check(
    '★ `source: "wrong"` → 400（守卫照常收口）',
    (await call('POST', '/api/quiz', { topic: 'derivative', source: 'wrong' })).status === 400,
  );
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
process.exitCode = failed > 0 ? 1 : 0;
