/**
 * 接口冒烟测试
 *
 * 依次验证说明书 5.2 契约中的全部端点，并走一遍核心闭环：
 *   材料 → 抽知识点 → 判定缺口(MISSING) → 一键补充 → 状态转 SUPPLEMENTED → 继续答疑
 *
 * 用法：先启动服务端（npm run dev:server），再执行
 *   node apps/server/scripts/smoke.mjs
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3000/api';

let passed = 0;
let failed = 0;

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  [通过] ${name}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

/** 演示用材料：讲解用导数符号判断单调性，但没有解释导数本身 */
const MONOTONICITY_MATERIAL = `定理：设函数 f(x) 在区间 I 上可导。
若在 I 上恒有 f'(x) > 0，则 f(x) 在 I 上单调递增；
若在 I 上恒有 f'(x) < 0，则 f(x) 在 I 上单调递减。
例：判断 f(x) = x^3 - 3x 的单调性。
解：f'(x) = 3x^2 - 3 = 3(x-1)(x+1)。
当 x < -1 或 x > 1 时 f'(x) > 0，函数递增；
当 -1 < x < 1 时 f'(x) < 0，函数递减。`;

async function main() {
  console.log(`冒烟测试目标：${BASE}\n`);

  console.log('1. 健康检查');
  const health = await call('GET', '/health');
  check('GET /api/health 返回 200', health.status === 200, health);
  check('响应包含 modelProvider', typeof health.body?.modelProvider === 'string', health.body);

  console.log('\n2. 创建会话');
  const session = await call('POST', '/session');
  check('POST /api/session 返回 201', session.status === 201, session);
  const sessionId = session.body?.id;
  check('返回会话 id', typeof sessionId === 'string', session.body);
  check('初始材料版本为 0', session.body?.materialVersion === 0, session.body);

  console.log('\n3. 上传材料并抽取知识点');
  const knowledge1 = await call('POST', '/knowledge', {
    sessionId,
    materials: [
      {
        id: 'material-1',
        kind: 'upload',
        text: MONOTONICITY_MATERIAL,
        createdAt: new Date().toISOString(),
      },
    ],
  });
  check('POST /api/knowledge 返回 200', knowledge1.status === 200, knowledge1);
  check('材料版本递增为 1', knowledge1.body?.materialVersion === 1, knowledge1.body);
  const derivative = knowledge1.body?.prerequisites?.find(
    (item) => item.conceptId === 'kp-derivative',
  );
  check('识别出导数前置依赖', derivative !== undefined, knowledge1.body?.prerequisites);
  check('导数状态为 MISSING（材料未覆盖）', derivative?.status === 'MISSING', derivative);

  console.log('\n4. 一键补充缺口（对应「补上这一段」）');
  const gap = await call('POST', '/gap', {
    sessionId,
    materialVersion: knowledge1.body?.materialVersion ?? 1,
    conceptId: 'kp-derivative',
    reason: derivative?.reason ?? '判断单调性需要导数的定义',
  });
  check('POST /api/gap 返回 200', gap.status === 200, gap);
  check('返回补充内容', typeof gap.body?.content === 'string' && gap.body.content.length > 50, gap.body);
  check('状态更新为 SUPPLEMENTED', gap.body?.status === 'SUPPLEMENTED', gap.body);
  check('材料版本递增为 2', gap.body?.materialVersion === 2, gap.body);

  console.log('\n5. 补充后重新判定依赖');
  const knowledge2 = await call('POST', '/knowledge', { sessionId, materials: [] });
  check('POST /api/knowledge 返回 200', knowledge2.status === 200, knowledge2);
  const derivative2 = knowledge2.body?.prerequisites?.find(
    (item) => item.conceptId === 'kp-derivative',
  );
  check(
    '导数状态转为 SUPPLEMENTED',
    derivative2?.status === 'SUPPLEMENTED',
    derivative2,
  );

  console.log('\n6. 材料路径答疑');
  const tutor1 = await call('POST', '/tutor', {
    sessionId,
    materialVersion: gap.body?.materialVersion ?? 2,
    question: "为什么 f'(x) > 0 就说明函数递增？",
    mode: 'explain',
  });
  check('POST /api/tutor 返回 200', tutor1.status === 200, tutor1);
  check('标记基于材料作答', tutor1.body?.basedOnMaterial === true, tutor1.body);
  check('返回至少一个回答块', Array.isArray(tutor1.body?.blocks) && tutor1.body.blocks.length > 0, tutor1.body);

  console.log('\n7. 零材料提问（轻路径）');
  const tutor2 = await call('POST', '/tutor', {
    sessionId: null,
    materialVersion: 0,
    question: '单调性是什么意思？',
    mode: 'explain',
  });
  check('零材料也能完成答疑', tutor2.status === 200, tutor2);
  check('标记未基于材料', tutor2.body?.basedOnMaterial === false, tutor2.body);

  console.log('\n8. 材料版本不匹配应被拒绝（用例 E8/E10 的前置条件）');
  const stale = await call('POST', '/tutor', {
    sessionId,
    materialVersion: 0,
    question: '测试过期版本',
    mode: 'explain',
  });
  check('过期版本返回错误', stale.status >= 400, stale);
  check('错误码为 SESSION_STALE', stale.body?.error?.code === 'SESSION_STALE', stale.body);

  console.log('\n9. 练习：固定题与按材料出题');
  const fixed = await call('GET', '/quiz?topic=monotonicity&source=fixed');
  check('固定题返回 3 道', fixed.body?.items?.length === 3, fixed.body);
  check(
    '固定题标注为项目自编',
    fixed.body?.items?.[0]?.stem?.includes('项目自编练习') === true,
    fixed.body?.items?.[0],
  );

  const generated = await call(
    'GET',
    `/quiz?topic=monotonicity&source=material&sessionId=${sessionId}`,
  );
  check('按材料出题返回 2 道', generated.body?.items?.length === 2, generated.body);
  check(
    '生成题标注来源为 material',
    generated.body?.items?.[0]?.source === 'material',
    generated.body?.items?.[0],
  );

  console.log('\n10. 错误处理');
  const badQuiz = await call('GET', '/quiz');
  check('缺少 topic 返回 400', badQuiz.status === 400, badQuiz);
  const emptyAsk = await call('POST', '/tutor', { sessionId: null, materialVersion: 0, question: '  ', mode: 'explain' });
  check('空问题返回 400', emptyAsk.status === 400, emptyAsk);
  const noSession = await call('POST', '/knowledge', { sessionId: 'not-exist', materials: [] });
  check('会话不存在返回 404', noSession.status === 404, noSession);

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟测试异常终止：', error);
  process.exit(1);
});
