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
 * 是否"看起来是一个具体文件"（路径末段带扩展名）。
 *
 * 回退到 `index.html` 只应服务于**前端路由**（`/dashboard` 这类无扩展名的路径）。
 * 带扩展名的请求是在指名要一个文件：取不到就该 404。
 * 返回首页 HTML 却是 200，会让"资源没打进镜像 / 哈希变了"看起来像"页面正常"。
 *
 * 本项目前端没有路由表（单页 + 面板切换，见 `apps/web/src`），
 * 现有页面路径里**没有一个带扩展名**，因此这条规则不会挡住任何真实路由。
 */
const ASSET_LIKE_PATH = /\.[a-z0-9]{1,8}$/i;

function looksLikeAsset(path: string): boolean {
  return ASSET_LIKE_PATH.test(path);
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
    if (isApiPath(req.path) || looksLikeAsset(req.path)) {
      next();
      return;
    }
    res.sendFile(indexHtml, (error) => {
      if (error) next(error);
    });
  };
  app.use(serveIndex);

  logger.info('web.dist.mounted', { dir: found });
  return { mounted: true, webDistDir: found };
}
