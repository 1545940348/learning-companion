/**
 * store 层「原子提交」验证脚本
 *
 * 验证说明书 9.3 要求的三件事：
 * 1. 模型失败时材料与版本不变（候选只存在于内存，不落盘）；
 * 2. 提交前复核版本，并发旧响应不得覆盖新状态；
 * 3. 成功后一次性更新，材料与版本同时生效。
 *
 * 与 HTTP 层无关，直接调用 store，因此不消耗任何模型额度、不需要密钥。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:store
 */

import {
  SessionVersionConflictError,
  clearSessions,
  commitMaterials,
  commitSupplement,
  createSession,
  getSession,
  previewMaterials,
} from '../src/store/index.js';

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

/** 构造一份合法材料（形状见 @lc/contracts 的 Material） */
function material(id, text) {
  return { id, kind: 'upload', text, createdAt: new Date().toISOString() };
}

/** 构造一个补充块（形状见 @lc/contracts 的 SupplementBlock） */
function supplement(sessionId, conceptId) {
  return {
    id: `sup-${conceptId}`,
    sessionId,
    conceptId,
    content: '（测试用补充内容）',
    authorizedAt: new Date().toISOString(),
  };
}

/** 存储中该会话的真实状态（未被预览函数影响的话，应与调用前一致） */
function stored(sessionId) {
  return getSession(sessionId);
}

console.log('=== store 层原子提交验证 ===\n');

/* ---------- 1. previewMaterials 是纯函数，不写入存储 ---------- */
console.log('1. previewMaterials 不落盘');
{
  clearSessions();
  const session = createSession();
  const before = stored(session.id);

  const candidate = previewMaterials(session, [material('m1', '导数与单调性')]);

  check('候选版本为 base + 1', candidate.materialVersion === 1, `实际 ${candidate.materialVersion}`);
  check('候选含 1 份材料', candidate.materials.length === 1, `实际 ${candidate.materials.length}`);
  check(
    '★ 存储中的会话未被改动（材料数）',
    stored(session.id).materials.length === 0,
    `实际 ${stored(session.id).materials.length}`,
  );
  check(
    '★ 存储中的会话未被改动（版本）',
    stored(session.id).materialVersion === 0,
    `实际 ${stored(session.id).materialVersion}`,
  );
  check('存储对象未被子集替换（引用不变）', stored(session.id) === before);
}

/* ---------- 2. 模拟模型失败：只预览、不提交 ---------- */
console.log('\n2. 模拟模型失败（预览后不提交）');
{
  clearSessions();
  const session = createSession();
  const baseVersion = session.materialVersion;

  // 这正是路由在模型失败时会走到的状态：候选构造好了，但没有 commit
  previewMaterials(session, [material('m1', '导数与单调性')]);
  previewMaterials(session, [material('m2', '切线方程')]);

  const after = stored(session.id);
  check('★ 材料数仍为 0', after.materials.length === 0, `实际 ${after.materials.length}`);
  check('★ 版本仍为 0', after.materialVersion === baseVersion, `实际 ${after.materialVersion}`);
}

/* ---------- 3. 正常提交：一次性生效 ---------- */
console.log('\n3. commitMaterials 正常提交');
{
  clearSessions();
  const session = createSession();
  const baseVersion = session.materialVersion;

  const updated = commitMaterials(session.id, [material('m1', '导数与单调性')], baseVersion);

  check('版本递增为 1', updated.materialVersion === 1, `实际 ${updated.materialVersion}`);
  check('返回值的材料数为 1', updated.materials.length === 1);
  check('存储已生效（材料数）', stored(session.id).materials.length === 1);
  check('存储已生效（版本）', stored(session.id).materialVersion === 1);
}

/* ---------- 4. 空材料：只复核版本，不递增 ---------- */
console.log('\n4. commitMaterials 空材料');
{
  clearSessions();
  const session = createSession();
  const updated = commitMaterials(session.id, [], session.materialVersion);

  check('版本保持 0', updated.materialVersion === 0, `实际 ${updated.materialVersion}`);
  check('材料数保持 0', stored(session.id).materials.length === 0);
}

/* ---------- 5. 版本冲突：过期版本必须被拒绝 ---------- */
console.log('\n5. commitMaterials 版本冲突（并发旧响应）');
{
  clearSessions();
  const session = createSession();

  // 请求 A 与请求 B 都读到版本 0
  const staleVersion = session.materialVersion;
  const freshVersion = stored(session.id).materialVersion;

  // A 先提交成功 → 版本变 1
  commitMaterials(session.id, [material('mA', '甲')], freshVersion);

  // B 拿着旧版本 0 去提交 → 必须被拒绝
  let threw = false;
  let caughtName = '';
  try {
    commitMaterials(session.id, [material('mB', '乙')], staleVersion);
  } catch (error) {
    threw = true;
    caughtName = error instanceof SessionVersionConflictError ? 'SessionVersionConflictError' : error.name;
  }

  check('★ 抛出 SessionVersionConflictError', threw && caughtName === 'SessionVersionConflictError', caughtName);
  check('★ 存储未被旧响应覆盖（材料数仍为 1）', stored(session.id).materials.length === 1, `实际 ${stored(session.id).materials.length}`);
  check('★ 存储未被旧响应覆盖（材料为甲）', stored(session.id).materials[0]?.id === 'mA', String(stored(session.id).materials[0]?.id));
  check('版本仍为 1', stored(session.id).materialVersion === 1, `实际 ${stored(session.id).materialVersion}`);
}

/* ---------- 6. 补充块的版本冲突与正常提交 ---------- */
console.log('\n6. commitSupplement');
{
  clearSessions();
  const session = createSession();

  // 正常提交
  const updated = commitSupplement(session.id, supplement(session.id, 'kp-derivative'), 0);
  check('正常提交后版本为 1', updated.materialVersion === 1, `实际 ${updated.materialVersion}`);
  check('补充块为 1 个', stored(session.id).supplements.length === 1);

  // 用过期版本再提交 → 拒绝
  let threw = false;
  try {
    commitSupplement(session.id, supplement(session.id, 'kp-limit'), 0);
  } catch (error) {
    threw = error instanceof SessionVersionConflictError;
  }
  check('★ 过期版本被拒绝', threw);
  check('★ 补充块仍为 1 个（未被覆盖）', stored(session.id).supplements.length === 1, `实际 ${stored(session.id).supplements.length}`);
}

/* ---------- 7. 不存在的会话 ---------- */
console.log('\n7. 会话不存在');
{
  clearSessions();
  let threw = false;
  try {
    commitMaterials('not-a-session', [material('m1', 'x')], 0);
  } catch (error) {
    threw = error.name === 'SessionNotFoundError';
  }
  check('抛出 SessionNotFoundError', threw);
}

clearSessions();

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
