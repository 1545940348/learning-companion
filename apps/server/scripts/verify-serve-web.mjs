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
 *    同时确认**前缀相近但不是接口**的 `/apifoo` 仍会正常回退；
 * 7. **判定的三个漏口**（2026-09-18 补，`I22`）：编码后的点号（`/foo%2Ejs`）、
 *    超过 8 字符的扩展名（`/manifest.webmanifest`）、结尾带斜杠（`/assets/`）
 *    一律 404；非法百分号序列（`/%zz`）与编码斜杠的接口路径（`/api%2Funknown`）
 *    同样不回退；
 * 8. **运行期产物消失是 404 而非 500**（2026-09-18 补，`I23`）：服务运行中
 *    `index.html` 被移走（`build:clean` 的重建窗口）不得报成服务端故障；
 * 9. **自动探测真的生效**（2026-09-18 修正，`I24`）：造出 `apps/web/dist` 后
 *    不传目录也必须找到 —— 原先那条断言是恒真式，覆盖不到
 *    `candidateWebDistDirs()`。
 *
 * ⚠️ 这里**没有**覆盖 `src/index.ts` 的挂载顺序（`/api` 之后、错误处理之前）：
 * 本脚本用的是自建的 Express 管线，顺序正确性只能靠 index.ts 自身保证。
 * 需要时单独补一条针对入口文件的断言。
 *
 * 断言一律**同时看状态码与内容**：只看"不是首页 HTML"是不够的 ——
 * 返回 500 也会满足那个条件，等于什么都没锁住。
 *
 * 全部在进程内起一个临时服务器完成，**不依赖外部服务、不消耗任何模型额度**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:serve-web
 */

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  SECURITY_HEADERS,
  cspDirectives,
  mountSecurityHeaders,
} from '../src/http/security-headers.js';
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

  // 与 `src/index.ts` 的挂载顺序保持一致：安全头 → json → 路由 → 静态托管。
  // （顺序正确性另有源码级断言，见第 5 节最后一条 —— 本脚本用的是自建管线，
  //   光在这里挂上并不能证明入口文件挂对了。）
  mountSecurityHeaders(app);
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

  /*
   * ★ 判定的三个漏口（2026-09-18 补，`I22`）。
   *
   * 修复前这四条**全部**会拿到 200 + 首页 HTML，而它们是同一个失效的另外三个入口：
   * ① `req.path` 没有解码 → `/foo%2Ejs` 的"点"在判定时看不见；
   * ② 扩展名正则带 `{1,8}` 长度上限 → `/manifest.webmanifest` 判不出"是文件"；
   * ③ 结尾带斜杠（`/assets/`）是目录式请求，不是前端路由。
   * 浏览器拿到 HTML 却按 JS 解析，报 `Unexpected token '<'`，而状态码是 200 ——
   * "资源没打进镜像"会看起来像"页面正常"。
   */
  const encodedDot = await fetch(`${baseUrl}/foo%2Ejs`);
  const encodedDotText = await encodedDot.text();
  check(
    '★ 编码后的点号（/foo%2Ejs）不返回首页',
    encodedDot.status === 404 && !encodedDotText.includes(INDEX_MARK),
    `实际 ${encodedDot.status}`,
  );

  const encodedDotInAssets = await fetch(`${baseUrl}/assets/not-built%2Ejs`);
  const encodedDotInAssetsText = await encodedDotInAssets.text();
  check(
    '★ 编码点号在资源目录下同样 404',
    encodedDotInAssets.status === 404 && !encodedDotInAssetsText.includes(INDEX_MARK),
    `实际 ${encodedDotInAssets.status}`,
  );

  const longExtension = await fetch(`${baseUrl}/manifest.webmanifest`);
  const longExtensionText = await longExtension.text();
  check(
    '★ 超过 8 字符的扩展名（/manifest.webmanifest）不返回首页',
    longExtension.status === 404 && !longExtensionText.includes(INDEX_MARK),
    `实际 ${longExtension.status}`,
  );

  const trailingSlash = await fetch(`${baseUrl}/assets/`);
  const trailingSlashText = await trailingSlash.text();
  check(
    '★ 结尾带斜杠（/assets/）不返回首页',
    trailingSlash.status === 404 && !trailingSlashText.includes(INDEX_MARK),
    `实际 ${trailingSlash.status}`,
  );

  /*
   * 失败要往严格的一侧倒：非法百分号序列**不能**被当成前端路由。
   * 解码失败时若按"无扩展名 → 路由"处理，`/%zz` 会拿到首页，判定就没有守住了。
   */
  const malformed = await fetch(`${baseUrl}/%zz`);
  const malformedText = await malformed.text();
  check(
    '★ 非法百分号序列（/%zz）不返回首页',
    malformed.status === 404 && !malformedText.includes(INDEX_MARK),
    `实际 ${malformed.status}`,
  );

  /*
   * 编码过的斜杠也要认得出来是接口：`req.path` 原值是 `/api%2Funknown`，
   * 不以 `/api/` 开头，若只判原值就会被吞成首页。
   */
  const encodedSlashApi = await fetch(`${baseUrl}/api%2Funknown`);
  const encodedSlashApiText = await encodedSlashApi.text();
  check(
    '★ 编码斜杠的接口路径（/api%2Funknown）不返回首页',
    encodedSlashApi.status === 404 && !encodedSlashApiText.includes(INDEX_MARK),
    `实际 ${encodedSlashApi.status}`,
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

/* ---------- 2b. 运行期产物消失：必须 404，不能 500 ---------- */
console.log('\n2b. 服务运行中前端产物被移走（重建窗口）');
{
  /*
   * `I23`：`res.sendFile` 的错误原先一律 `next(error)`，而 `errorHandler` 没有
   * `err.status` 分支，于是"index.html 不见了"变成 **500 INTERNAL** + 一条 error 级
   * `http.unhandled` 日志。本项目自己的 `npm run build:clean` 就会把
   * `apps/web/dist` 挪进回收站 —— 整个重建窗口内，早先启动的服务每次访问页面都 500，
   * 把"正在重建"报成"服务端故障"，还污染了真正需要关注的错误日志。
   */
  const webDist = await makeFakeWebDist();
  tmpDirs.push(webDist);
  const { baseUrl, close } = await startServer(webDist);

  const before = await fetch(`${baseUrl}/`);
  check('移走之前 GET / 正常', before.status === 200, `实际 ${before.status}`);

  await rm(join(webDist, 'index.html'), { force: true });

  const home = await fetch(`${baseUrl}/`);
  const homeText = await home.text();
  check(
    '★ 产物消失后 GET / 是 404（不是 500）',
    home.status === 404,
    `实际 ${home.status}${home.status === 500 ? ' —— 又落回 INTERNAL 了' : ''}`,
  );
  check('★ 产物消失后不返回首页 HTML', !homeText.includes(INDEX_MARK));

  await close();
}

/* ---------- 3. 自动探测：默认不传目录也能找到 ---------- */
console.log('\n3. 自动探测（不传 webDistDir）');
{
  /*
   * `I24`（2026-09-18 修正）：原先这里只有一条**恒真式** ——
   * `typeof result.mounted === 'boolean' && result.webDistDir !== undefined`。
   * `mountWebApp` 必然返回 boolean，而 `webDistDir` 的类型是 `string | null`，
   * 于是任何"不崩"的返回值都能满足它。把 `candidateWebDistDirs()` 改成 `return []`，
   * 脚本仍然全绿 —— 而那个函数决定了 CloudBase 容器里能不能提供页面。
   *
   * 现在分两层断言：
   * ① **返回值必须自洽**（挂载了就必须给出真实存在的 index.html，没挂载就必须是 null）；
   * ② **独立重算候选表**并比对结果。
   *
   * ⚠️ ② 里刻意**重写**了一遍候选目录，而不是从模块里 import 那个函数：
   * 与实现同源的断言无法发现"实现被清空"（`return []` 时两边会一起变空、断言恒真）。
   * 代价是两处需要同步，所以这里把那四条候选按文档顺序抄下来 —— 它们是模块 doc 里
   * 写死的公开约定，不是实现细节。
   */
  const { result, close } = await startServer(undefined);
  check(
    '不传目录时返回值自洽（挂载⇒目录真实存在；未挂载⇒null）',
    typeof result.mounted === 'boolean' &&
      (result.mounted
        ? typeof result.webDistDir === 'string' && existsSync(join(result.webDistDir, 'index.html'))
        : result.webDistDir === null),
    `mounted=${result.mounted} webDistDir=${String(result.webDistDir)}`,
  );
  console.log(
    `        本次探测结果：${result.mounted ? `找到 ${result.webDistDir}` : '未找到（正常，可能尚未构建前端）'}`,
  );
  await close();

  // 独立复算：模块位置（apps/server/src/http）＋ cwd，与 `serve-web.ts` 的 doc 一致
  const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/http');
  const documentedCandidates = [
    resolve(moduleDir, '../../../web/dist'),
    resolve(moduleDir, '../../web/dist'),
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ];
  const anyCandidateExists = documentedCandidates.some((dir) =>
    existsSync(join(dir, 'index.html')),
  );
  check(
    '★ 自动探测结果与"候选目录是否存在"一致（候选表被清空会在这里失败）',
    result.mounted === anyCandidateExists,
    `mounted=${result.mounted}，但候选里${anyCandidateExists ? '有' : '没有'}index.html`,
  );
}

/* ---------- 5. 安全响应头（阶段 0 · 卡 1 / D-01） ---------- */
console.log('\n5. 安全响应头（必须对所有响应生效，含 /api 与 404）');
{
  const webDist = await makeFakeWebDist();
  tmpDirs.push(webDist);
  const { baseUrl, close } = await startServer(webDist);

  const home = await fetch(`${baseUrl}/`);
  await home.text();
  const api = await fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await api.json();
  const missing = await fetch(`${baseUrl}/nope.js`);
  await missing.text();

  // ① CSP 逐指令比对（不用 includes：少一条或值被改都会失败）
  const csp = home.headers.get('content-security-policy');
  const actual = csp === null ? {} : Object.fromEntries(
    csp.split('; ').map((part) => {
      const [key, ...rest] = part.split(' ');
      return [key, rest.join(' ')];
    }),
  );
  const expected = cspDirectives();
  const cspOk =
    csp !== null &&
    Object.keys(expected).length === Object.keys(actual).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
  check(
    `★ CSP 逐指令一致（${Object.keys(expected).length} 条指令，多一条少一条都算失败）`,
    cspOk,
    csp,
  );

  // ② CSP 里**不含** 'unsafe-inline' / 'unsafe-eval'（实测过没必要放宽，见模块说明）
  check(
    '★ CSP 不含 unsafe-inline / unsafe-eval（放宽会让 XSS 第二道防线失效）',
    csp !== null && !/unsafe-inline|unsafe-eval/.test(csp),
    csp,
  );

  // ③–⑦ 其余六条头的精确值
  for (const [name, value] of SECURITY_HEADERS) {
    if (name === 'Content-Security-Policy') continue;
    const got = home.headers.get(name.toLowerCase());
    check(`${name} 值精确匹配`, got === value, got === null ? '(缺失)' : got);
  }

  // ⑧ 同一组头在 /api 响应上也存在（证明挂在全局而不是只挂静态路径）
  const apiHeaders = SECURITY_HEADERS.map(([name]) => api.headers.get(name.toLowerCase()));
  check(
    '★ /api 响应也带全部安全头（挂在全局，不是只挂在静态路径）',
    apiHeaders.every((value) => value !== null),
    apiHeaders.filter((value) => value === null).length + ' 条缺失',
  );

  // ⑨ 404 响应也带（错误路径同样不该裸奔）
  check(
    '★ 404 响应也带安全头（含 X-Content-Type-Options）',
    missing.status === 404 && missing.headers.get('x-content-type-options') === 'nosniff',
    `status=${missing.status} nosniff=${missing.headers.get('x-content-type-options')}`,
  );

  // ⑩ 不得出现 CORS 头（阶段 0 口径：同源部署不需要 CORS，且将来有 cookie 后
  //    "白名单 + Allow-Credentials" 等于把登录态借给白名单里的任何源）
  check(
    '★ 不出现 Access-Control-Allow-Origin',
    home.headers.get('access-control-allow-origin') === null,
    home.headers.get('access-control-allow-origin'),
  );
  check(
    '★ 不出现 Access-Control-Allow-Credentials',
    home.headers.get('access-control-allow-credentials') === null,
    home.headers.get('access-control-allow-credentials'),
  );

  // ⑪ HTTP 下**不发** HSTS：HTTP 站点发 HSTS 无意义，且会把站点锁死在 https
  check(
    '★ HTTP 响应不带 Strict-Transport-Security（只在 HTTPS 下发）',
    home.headers.get('strict-transport-security') === null,
    home.headers.get('strict-transport-security'),
  );
  const httpsLike = await fetch(`${baseUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
  await httpsLike.text();
  check(
    '★ 声明 https（x-forwarded-proto）时才带 HSTS',
    httpsLike.headers.get('strict-transport-security') ===
      'max-age=31536000; includeSubDomains',
    httpsLike.headers.get('strict-transport-security'),
  );

  await close();
}

/*
 * ⑫ 源码级断言：`src/index.ts` 必须**在注册任何路由之前**挂安全头。
 *
 * 为什么需要它：本脚本用的是自建 Express 管线（见文件头注释），
 * 上面十条断言只能证明**这个中间件本身**是对的，证明不了入口文件把它挂对了位置。
 * 挂到 `/api` 路由之后 → `/api` 与 404 就会漏掉 —— 那是最容易犯、也最难靠
 * "打开页面看一眼"发现的错（页面正常，只是接口没头）。
 */
{
  const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
  const source = await readFile(indexPath, 'utf8');
  const mountAt = source.indexOf('mountSecurityHeaders(app)');
  const apiAt = source.indexOf("app.use('/api', apiRouter)");
  check(
    '★ 入口文件在注册路由之前挂载安全头（挂在后面会让 /api 与 404 漏掉）',
    mountAt !== -1 && apiAt !== -1 && mountAt < apiAt,
    `mountAt=${mountAt} apiAt=${apiAt}`,
  );
}

// 清理临时目录
for (const dir of tmpDirs) {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
}
