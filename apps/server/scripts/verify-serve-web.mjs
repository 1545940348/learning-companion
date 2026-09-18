/**
 * 同源托管（serve-web）的验证脚本
 *
 * 验证目标 —— 说明书 V2.0 · `P-C13`「前后端同源部署」：
 * 同一个地址既要能取到页面，也要能取到 `/api`，而且两者不能互相污染。
 *
 * 覆盖的关键边界：
 * 1. **目录不存在时不崩**：只提供 `/api`，服务照常可用；
 * 2. 首页与静态资源可取；
 * 3. **SPA 回退**：前端路由（如 `/dashboard`）刷新不 404；
 * 4. **`/api` 不被吞**：不存在的接口路径仍是 404，不能被回退成 HTML；
 * 5. **写请求不回退**：POST 到未知路径不能返回首页 HTML；
 * 6. **"看起来是文件"的路径不回退**（2026-09-18 补）：取不到的静态资源、
 *    `/favicon.ico`、`/.env` 必须 404，不能被回退成 200 + 首页；
 *    同时确认**前缀相近但不是接口**的 `/apifoo` 仍会正常回退。
 *
 * 断言一律**同时看状态码与内容**：只看"不是首页 HTML"是不够的 ——
 * 返回 500 也会满足那个条件，等于什么都没锁住。
 *
 * 全部在进程内起一个临时服务器完成，**不依赖外部服务、不消耗任何模型额度**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:serve-web
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { mountWebApp } from '../src/http/serve-web.js';

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

const INDEX_MARK = 'FAKE-INDEX-DO-NOT-SHIP';
const ASSET_MARK = 'FAKE-ASSET-JS';

/** 造一个假的「前端产物目录」 */
async function makeFakeWebDist() {
  const dir = await mkdtemp(join(tmpdir(), 'lc-webdist-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html><body>${INDEX_MARK}</body></html>`,
    'utf8',
  );
  await writeFile(join(dir, 'assets', 'app.js'), `// ${ASSET_MARK}\n`, 'utf8');
  return dir;
}

/** 起一个临时服务器，返回 baseUrl 与关闭函数 */
async function startServer(webDistDir) {
  const app = express();
  app.use(express.json());

  // 模拟一个真实接口
  app.post('/api/echo', (req, res) => {
    res.json({ ok: true, body: req.body ?? null });
  });

  const result = mountWebApp(app, webDistDir === undefined ? {} : { webDistDir });

  const server = await new Promise((resolveListen) => {
    const s = app.listen(0, () => resolveListen(s));
  });
  const { port } = server.address();
  return {
    result,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

console.log('=== 同源托管（serve-web）验证 ===\n');

const tmpDirs = [];

/* ---------- 1. 目录存在：页面、资源、回退都对 ---------- */
console.log('1. 前端产物存在时');
{
  const webDist = await makeFakeWebDist();
  tmpDirs.push(webDist);
  const { result, baseUrl, close } = await startServer(webDist);

  check('mountWebApp 报告已挂载', result.mounted === true);
  check('返回的目录与传入一致', result.webDistDir === webDist, String(result.webDistDir));

  const home = await fetch(`${baseUrl}/`);
  const homeText = await home.text();
  check('GET / 返回 200', home.status === 200, `实际 ${home.status}`);
  check('GET / 内容是首页 HTML', homeText.includes(INDEX_MARK));

  const asset = await fetch(`${baseUrl}/assets/app.js`);
  const assetText = await asset.text();
  check('静态资源可取', asset.status === 200 && assetText.includes(ASSET_MARK), `实际 ${asset.status}`);

  // SPA 回退：前端路由刷新不能 404
  const deep = await fetch(`${baseUrl}/dashboard`);
  const deepText = await deep.text();
  check('★ SPA 回退：/dashboard 返回首页', deep.status === 200 && deepText.includes(INDEX_MARK), `实际 ${deep.status}`);

  // /api 正常
  const api = await fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  const apiJson = await api.json();
  check('POST /api/echo 正常', api.status === 200 && apiJson.ok === true, `实际 ${api.status}`);

  // ★ 关键：不存在的接口不能被吞成首页 HTML（**状态码也要一起断言**，见文件头）
  const unknownApi = await fetch(`${baseUrl}/api/definitely-not-a-route`);
  const unknownApiText = await unknownApi.text();
  check(
    '★ /api 未知路径是 404，且不是首页 HTML',
    unknownApi.status === 404 && !unknownApiText.includes(INDEX_MARK),
    `实际 ${unknownApi.status}`,
  );

  // ★ 关键：写请求不能被回退
  const unknownPost = await fetch(`${baseUrl}/definitely-not-a-route`, { method: 'POST' });
  const unknownPostText = await unknownPost.text();
  check(
    '★ POST 未知路径是 404，且不被回退成首页',
    unknownPost.status === 404 && !unknownPostText.includes(INDEX_MARK),
    `实际 ${unknownPost.status}`,
  );

  /*
   * ★ 回退范围：只服务"前端路由"，不服务"具体文件"（2026-09-18 补）。
   *
   * 修复前这四条里有三条会失败：`/assets/...` 与 `/favicon.ico` 会拿到
   * 200 + 首页 HTML，浏览器按 JS 解析就报 `Unexpected token '<'`，
   * 而"资源没打进镜像"这件事看起来像"页面正常"。
   */
  const missingAsset = await fetch(`${baseUrl}/assets/not-built.js`);
  const missingAssetText = await missingAsset.text();
  check(
    '★ 取不到的静态资源是 404，不返回首页',
    missingAsset.status === 404 && !missingAssetText.includes(INDEX_MARK),
    `实际 ${missingAsset.status}`,
  );

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  const faviconText = await favicon.text();
  check(
    '★ /favicon.ico 不返回首页 HTML',
    favicon.status === 404 && !faviconText.includes(INDEX_MARK),
    `实际 ${favicon.status}`,
  );

  const dotfile = await fetch(`${baseUrl}/.env`);
  const dotfileText = await dotfile.text();
  check(
    '★ /.env 之类点文件不返回首页 HTML',
    dotfile.status === 404 && !dotfileText.includes(INDEX_MARK),
    `实际 ${dotfile.status}`,
  );

  // 反过来也要锁住：**前缀相近但不是接口**的路径必须仍然回退
  const apiLike = await fetch(`${baseUrl}/apifoo`);
  const apiLikeText = await apiLike.text();
  check(
    '★ /apifoo 这类"前缀相近但非接口"的路径仍回退（别把回退范围收得过头）',
    apiLike.status === 200 && apiLikeText.includes(INDEX_MARK),
    `实际 ${apiLike.status}`,
  );

  await close();
}

/* ---------- 2. 目录不存在：不崩，只提供 /api ---------- */
console.log('\n2. 前端产物不存在时（纯后端联调场景）');
{
  const missing = resolve(tmpdir(), 'lc-webdist-definitely-missing');
  const { result, baseUrl, close } = await startServer(missing);

  check('★ mountWebApp 报告未挂载（不抛异常）', result.mounted === false);
  check('未挂载时目录为 null', result.webDistDir === null);

  const home = await fetch(`${baseUrl}/`);
  check('GET / 不再是首页（无回退）', home.status === 404, `实际 ${home.status}`);

  const api = await fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('★ 未挂载时 /api 依然可用', api.status === 200, `实际 ${api.status}`);

  await close();
}

/* ---------- 3. 自动探测：默认不传目录也能找到 ---------- */
console.log('\n3. 自动探测（不传 webDistDir）');
{
  // 仓库里 apps/web/dist 是否存在取决于有没有构建过，两种结果都算通过，
  // 这里只断言「不崩、返回结构正确」。
  const { result, close } = await startServer(undefined);
  check('不传目录时返回结构正确', typeof result.mounted === 'boolean' && result.webDistDir !== undefined);
  console.log(
    `        本次探测结果：${result.mounted ? `找到 ${result.webDistDir}` : '未找到（正常，可能尚未构建前端）'}`,
  );
  await close();
}

// 清理临时目录
for (const dir of tmpDirs) {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
