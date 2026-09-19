/**
 * 同源托管前端构建产物（说明书 V2.0 · `P-C13`「前后端同源部署」）
 *
 * 目的：让**同一个地址**既提供页面、也提供 `/api` 接口。
 * 这样评委点开一个链接就能用，不需要另配前端地址，也不需要配任何密钥。
 *
 * ### 为什么单独成模块
 *
 * `src/index.ts` 是服务入口，只保留「组装」职责。托管细节（找目录、判存在、
 * SPA 回退、日志）放在这里，好处有三：
 * 1. 入口文件不随功能增长而膨胀；
 * 2. 这段逻辑能被单独验证（见 `scripts/verify-serve-web.mjs`）；
 * 3. 将来要换成对象存储托管时，只改这一个文件。
 *
 * ### 边界与失败处理（防御性）
 *
 * - **目录不存在**：只打印一条警告，**不抛异常、不阻止启动**。
 *   纯后端联调（只调 `/api`）时前端可能压根没构建过，服务仍应可用。
 * - **只回退 GET / HEAD**：POST 等写请求**绝不**被回退成 HTML，
 *   否则前端会拿到一段 HTML 却按 JSON 解析，错误会极难定位。
 * - **`/api/*` 永不回退**：不匹配的接口路径保持原有的 404 行为，
 *   不能被吞成首页（那会让接口错误变成"看起来正常"）。
 * - **"看起来是文件"的路径也不回退**：带扩展名的路径（`/favicon.ico`、`/.env`、
 *   `/assets/index-abc123.js`）一律交给后面的 404，**不换成首页**。
 *   理由与 `/api/*` 完全一样：构建产物哈希变了或资源漏打进镜像时，
 *   浏览器会拿到一段 HTML 却按 JS 解析（`Unexpected token '<'`），
 *   而状态码还是 200 —— 排查时会被引到完全错误的方向。
 * - ⚠️ **判定必须先解码、且不能给扩展名设长度上限**（2026-09-18 修正）。
 *   原先直接对**未解码**的 `req.path` 匹配 `\.[a-z0-9]{1,8}$`，于是
 *   `/foo%2Ejs`（编码后的点）、`/manifest.webmanifest`（扩展名超过 8 字符）、
 *   `/assets/`（结尾带斜杠）三种请求全都绕过判定、拿到 `200` + 首页 HTML ——
 *   正是这条规则要防的失效。现在：解码后再判、扩展名不限长度、结尾带斜杠的
 *   目录式请求一律不当作前端路由。解码失败（非法百分号序列）时**按文件处理**，
 *   同样交给 404（失败要往"更严格"的一侧倒）。
 * - **运行期产物消失回 404，不回 500**：`res.sendFile` 的 `ENOENT` 曾一路转给
 *   `errorHandler`，那里没有 `err.status` 分支，于是"index.html 不见了"变成
 *   `500 INTERNAL` + 一条 error 级日志。本项目自己的 `npm run build:clean`
 *   就会把 `apps/web/dist` 挪走，整个重建窗口内早先启动的服务每次访问页面都 500。
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import { logger } from '../logger.js';

/**
 * 候选的前端产物目录。
 *
 * 同一份代码在「开发态」与「构建态」下的位置层级不同，所以按顺序探测：
 * - 开发态（tsx 直跑源码）：`apps/server/src/http/` → 上三级到 `apps/`
 * - 构建态（tsup 打平成一个文件）：`apps/server/dist/` → 上两级到 `apps/`
 * - 以 `apps/server` 为工作目录启动（`npm start -w @lc/server`）
 * - 以仓库根为工作目录启动
 *
 * 找第一个含 `index.html` 的目录。全都找不到时不报错，只降级为「只提供 /api」。
 */
function candidateWebDistDirs(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, '../../../web/dist'),
    resolve(here, '../../web/dist'),
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ];
}

/**
 * 是否是接口路径。
 *
 * 用 `=== '/api' || startsWith('/api/')` 而不是裸 `startsWith('/api')`：
 * 后者会把 `/apifoo`、`/apiary` 这种"前缀相同、并不是接口"的路径也一起排除，
 * 而它们本该像其它前端路径一样回退。
 */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * 解码**仅用于判定**的请求路径。
 *
 * `req.path` 的原值**没有解码**（Express 的 `req.path` 取自 `parseurl().pathname`），
 * 所以 `/foo%2Ejs` 在判定时看不到那个点。这里解码后再判类别；
 * **绝不**用解码结果去拼文件路径 —— 真正读文件的仍是 `express.static`（它自带防护）。
 *
 * 非法百分号序列（`decodeURIComponent` 抛错）返回 `null`，
 * 由调用方按"不是前端路由"处理 —— 判定失败时倒向更严格的一侧。
 */
function decodeForClassification(rawPath: string): string | null {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

/**
 * 是否"看起来是一个具体文件"——即**不该**回退成 `index.html`。
 *
 * 回退只应服务于**前端路由**（`/dashboard` 这类无扩展名的路径）。三种情况不算前端路由：
 * 1. 末段带点（`/favicon.ico`、`/.env`、`/assets/index-abc123.js`、
 *    `/manifest.webmanifest` —— **不限扩展名长度**）；
 * 2. 结尾带斜杠（`/assets/`）—— 这是目录式请求，本项目没有任何以 `/` 结尾的路由；
 * 3. 解码失败（`%zz` 之类）—— 由调用方传 `null` 进来。
 *
 * 注意判定只看**最后一段**：`/v1.2/dashboard` 里的点不算数（本项目也没有这种路由）。
 * 根路径 `/` 单独放行，它是首页本身。
 */
function looksLikeAsset(decodedPath: string | null): boolean {
  if (decodedPath === null) return true; // 判定失败 → 按文件处理，交给 404
  if (decodedPath === '/') return false; // 根路径就是首页
  if (decodedPath.endsWith('/')) return true; // 目录式请求，不是路由
  const lastSegment = decodedPath.slice(decodedPath.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}

export interface ServeWebOptions {
  /**
   * 显式指定前端产物目录。
   * 填了就**不再探测**，直接用它 —— 平台目录结构与本地不同时的兜底手段。
   */
  readonly webDistDir?: string;
}

export interface ServeWebResult {
  /** 是否真的挂载了静态资源托付 */
  readonly mounted: boolean;
  /** 实际使用的目录；未挂载时为 null */
  readonly webDistDir: string | null;
}

/**
 * 把前端构建产物挂到 Express 应用上。
 *
 * @param app    Express 应用实例（须在 `/api` 路由之后、错误处理之前调用）
 * @param options 可选覆盖项，见 {@link ServeWebOptions}
 * @returns 挂载结果；`mounted: false` 表示只提供 `/api`
 */
export function mountWebApp(app: Express, options: ServeWebOptions = {}): ServeWebResult {
  const explicit = options.webDistDir?.trim();
  const candidates = explicit ? [explicit] : candidateWebDistDirs();
  const found = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

  if (found === undefined) {
    logger.warn('web.dist.missing', {
      triedDirs: candidates.length,
      hint: '本次只提供 /api。如需页面，请先 npm run build，或用 WEB_DIST_DIR 指定目录。',
    });
    return { mounted: false, webDistDir: null };
  }

  const indexHtml = resolve(found, 'index.html');

  // 静态资源（/assets/xxx.js 等）。
  // 刻意不设 maxAge：演示时最怕"改了页面却拿到旧缓存"，稳定优先于省流量。
  app.use(express.static(found, { index: false }));

  // SPA 回退：前端路由（如 /dashboard）刷新时不能 404。
  const serveIndex: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const decoded = decodeForClassification(req.path);
    // 解码后的路径也要判一次 `/api`：`/api%2Ffoo` 的原值不以 `/api/` 开头，
    // 但它是接口，不该被吞成首页。
    if (isApiPath(req.path) || isApiPath(decoded ?? '') || looksLikeAsset(decoded)) {
      next();
      return;
    }
    res.sendFile(indexHtml, (error) => {
      if (!error) return;

      /*
       * 运行期 index.html 消失 → **404**，不是 500。
       *
       * 这不是"我们有缺陷"，而是"这个资源现在不存在"：`npm run build:clean`
       * 会把 `apps/web/dist` 整个挪走，重建窗口内每次访问页面都会走到这里。
       * 原先一律 `next(error)`，而 `errorHandler` 没有 `err.status` 分支，
       * 于是给出 `500 INTERNAL` 并记一条 error 级 `http.unhandled` —— 把
       * "正在重建"报成"服务端故障"，还污染了真正需要关注的错误日志。
       */
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
        logger.warn('web.index.missing', { path: req.path, code });
        res
          .status(404)
          .type('text/plain; charset=utf-8')
          .send('页面资源暂不可用：前端产物不在当前目录（可能正在重新构建）。');
        return;
      }

      // 其余错误（权限、磁盘等）仍属服务端异常，交给统一错误处理
      next(error);
    });
  };
  app.use(serveIndex);

  logger.info('web.dist.mounted', { dir: found });
  return { mounted: true, webDistDir: found };
}
