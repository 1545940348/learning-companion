/**
 * 构建产物可运行性验证（对应待办 B1）
 *
 * ### 为什么必须有这个脚本
 *
 * `npm run build` 成功**不等于**产物能跑。曾出现过这种情况：
 * 构建绿灯，但 `node dist/index.js` 启动即崩 ——
 * `Cannot find module '.../packages/contracts/src/session.js'`。
 * 根因是 workspace 私有包的类型入口指向 TS 源码，开发期运行器能做 `.js → .ts` 映射，
 * **原生 node 不能**。这个故障直接阻断了在线链接的交付，而且**构建输出里毫无迹象**。
 *
 * 结论：必须**真的把产物拉起来打一次接口**，才叫验证通过。
 *
 * ### 与其它验证脚本的区别
 *
 * - `verify:all`（store / errors / guards / graph）：纯函数与 store 层，读 TS 源码
 * - `verify:flow`：打真实 HTTP，但跑的是**开发期运行器**
 * - **本脚本**：打真实 HTTP，跑的是**构建产物** —— 唯一覆盖"部署形态"的验证
 *
 * ### 用法
 *
 *   npm run build -w @lc/server      # 先生成 dist
 *   npm run verify:dist -w @lc/server
 *
 * 可用 `DIST_PORT` 指定端口（默认 3210）。不消耗模型额度。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const entry = resolve(serverRoot, 'dist/index.js');
const PORT = process.env.DIST_PORT ?? '3210';
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail !== undefined ? ` —— ${JSON.stringify(detail)}` : ''}`);
  }
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

console.log('=== 构建产物可运行性验证 ===\n');

if (!existsSync(entry)) {
  console.log(`  [失败] 找不到构建产物：${entry}`);
  console.log('        请先执行：npm run build -w @lc/server');
  process.exit(1);
}
check('构建产物存在', true);

console.log('\n--- 启动产物（原生 node，非开发期运行器）---');

const child = spawn(process.execPath, [entry], {
  cwd: serverRoot,
  env: { ...process.env, MODEL_PROVIDER: 'mock', PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

let exited = false;
let exitCode = null;
child.on('exit', (code) => {
  exited = true;
  exitCode = code;
});

/** 启动期间就退出 = 启动失败，直接把 stderr 交给调用者看 */
async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    if (exited) return false;
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let ready = false;
try {
  ready = await waitReady();
} catch (error) {
  console.log('  等待启动时异常：', error?.message);
}

if (!ready) {
  console.log('  [失败] 产物未能在限时内提供服务');
  if (exited) {
    console.log(`        进程已退出，exit code = ${exitCode}`);
  }
  const tail = (stderr || stdout).trim().split('\n').slice(0, 12).join('\n');
  if (tail) console.log(`        输出片段：\n${tail}`);
  console.log('\n  ⚠️ 这正是 B1 曾经的表现：构建成功但产物不可运行。');
  console.log('     检查 apps/server/tsup.config.ts 的 noExternal 是否把 @lc/* 内联。');
  if (!exited) child.kill();
  process.exitCode = 1;
} else {
  check('★ 产物以原生 node 启动成功（B1 的验收点）', true);

  const health = await call('GET', '/api/health');
  check('GET /api/health 200', health.status === 200, health.status);
  check('health 如实报 mock 通道', health.json?.mock === true, health.json?.mock);
  check('health 含验证引擎状态', typeof health.json?.verification?.engine === 'string', health.json?.verification);

  // 再多打两个路由，确保内联后的依赖真的可用（不只是"进程活着"）
  const session = await call('POST', '/api/session');
  check('POST /api/session 201 且含空图谱', session.status === 201 && Array.isArray(session.json?.graph?.nodes), session.status);

  const quiz = await call('POST', '/api/quiz', { topic: 'derivative', source: 'fixed' });
  check('POST /api/quiz 返回固定题（教学模块内联后可用）', quiz.status === 200 && quiz.json?.items?.length === 3, quiz.json?.items?.length);

  const graph = await call('GET', `/api/graph?sessionId=${session.json?.id}`);
  check('GET /api/graph 可读（共享契约内联后可用）', graph.status === 200, graph.status);

  child.kill();
  console.log('\n--- 已关闭产物进程 ---');
}

await new Promise((r) => setTimeout(r, 300));
console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
