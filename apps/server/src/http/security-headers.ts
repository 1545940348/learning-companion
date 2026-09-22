/**
 * 安全响应头（拆分阶段 0 · 卡 1 / 缺陷 `D-01`）
 *
 * ### 为什么要单独成模块
 *
 * 这组头必须对**所有响应**生效 —— 页面、静态资源、`/api`、404、错误响应。
 * 如果写在 `mountWebApp()` 里，`/api` 与 404 就会漏掉（`mountWebApp()` 的文档也明确
 * 要求"须在 `/api` 路由之后调用"）。所以它在 `index.ts` 里**紧跟 json 解析之后、
 * 所有路由之前**挂载 —— 挂在最前面，后面任何分支产生的响应都会带上它。
 *
 * ### 头集合是"常量数组 + 一次遍历"
 *
 * 回滚 = 注释掉 `index.ts` 里的一行挂载，不动其它逻辑（阶段 0 的回滚要求）。
 *
 * ### 刻意没上的几项（理由都要留档，避免以后有人"顺手补上"）
 *
 * - **`require-trusted-types-for 'script'`**：React 19 默认不使用 Trusted Types API，
 *   贸然开启会**直接打挂页面**。等阶段 8 在 CI 的浏览器测试里验证后再开。
 * - **`Cross-Origin-Embedder-Policy`**：计划书 §10.4.5 的结论是"评估后不加"——
 *   现在加不会有问题（无跨源资源），但将来一旦接入任何跨源图片/字体就会打挂，风险大于收益。
 * - **`Strict-Transport-Security`**：**只在 `req.secure` 为真时发送**。云托管默认域名前面
 *   有一层「访问提示中间页」，平台可能不在我方可控的响应里；更关键的是
 *   **HSTS 在 HTTP 下无意义且会把 http 站点锁死**，所以不能无条件发。
 *
 * ### `microphone=(self)` 是**有意放行**，不是漏配（2026-09-22 线上定位后修改）
 *
 * 原先这里是 `microphone=()` —— 那是「**本站谁都不许用麦克风**」。后果不是"点了报个权限错误"
 * 这么轻：浏览器**连授权弹窗都不会弹**，直接回 `not-allowed`。而界面上的文案还写着
 * "去地址栏的权限提示里放行麦克风" —— 地址栏**根本不会出现那个图标**，
 * 学生被引向一条做不了的路，看上去就是"语音功能坏了"。
 *
 * 界面上的「语音输入」走 `D3` 的**浏览器内置识别**
 * （`apps/web/src/shared/lib/voice-support.ts`），确实需要麦克风权限，
 * 因此这里放行**同源**（`self`）；**不放行任何第三方**（`microphone=*` 会让被嵌入的
 * 任意页面也能要麦克风，不做）。其余四项（camera / geolocation / payment / usb）
 * 本项目确实不用，维持空名单。
 *
 * 判据（可复用）：**"某条通道没接"要写在能力声明里**（`/api/health` 的 `capabilities`），
 * **不能靠一个安全头把功能悄悄关掉** —— 关掉之后学生看到的错误原因全是错的。
 * 副作用已评估：头的**条数不变**（仍是 7 条 + HSTS），变的只是 `microphone` 一项的值。
 *
 * ### 与 CSP 相关的事实（2026-09-19 实测，见 `plans/2026-09-19-阶段0实施准备（可执行）.md` §0）
 *
 * 计划书标"上线前必须验证的三件事"已实测：构建产物**无内联脚本**、全仓 **0 处** `style={{}}`、
 * CSS 与组件**无任何外链资源**（`grep url(` 与 `grep https?://` 均为空）。
 * 因此 `script-src 'self'` / `style-src 'self'` 可以成立，**不需要** `'unsafe-inline'`。
 */

import type { Express, RequestHandler } from 'express';

/**
 * CSP 指令集合。
 *
 * - `img-src 'self' data:` —— 允许 `data:` 是因为材料图片预览走 data URL（说明书 §2.2：
 *   图片不长期保存，识别后作为文本入库），这是**受控的白名单**，不是通配。
 * - `frame-ancestors 'none'` 与 `X-Frame-Options: DENY` **同时给**：前者是现代标准、
 *   后者覆盖老浏览器；重复不冲突。
 * - `object-src 'none'` / `base-uri 'none'` / `form-action 'self'`：本项目不用
 *   `<object>`、不用 `<base>`、不向站外提交表单，收窄没有代价。
 */
const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/** 所有响应都带的头（顺序无关，保持稳定便于比对） */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['Content-Security-Policy', CSP_VALUE],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  // ⚠️ `microphone=(self)` 是**有意放行**：界面上的「语音输入」走浏览器内置识别，
  //    需要麦克风权限。写成 `()` 会让浏览器**连授权弹窗都不弹**、直接回 not-allowed
  //    （2026-09-22 线上实测踩过）。理由与副作用见文件头说明。
  ['Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];

/** HTTPS 下才发的头（见文件头说明：HTTP 下发 HSTS 会把 http 站点锁死） */
export const HTTPS_ONLY_HEADERS: readonly (readonly [string, string])[] = [
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
];

/**
 * 把安全响应头挂到应用上。**必须在本应用注册任何路由之前调用**。
 *
 * 用 `setHeader` 而不是第三方 `helmet`：本项目只有 7 条头，引一个依赖不划算
 * （也符合阶段 0 的依赖纪律 —— 见 `D6` 拍板：新增依赖只允许 `eslint` 与 `dependency-cruiser`）。
 */
export function mountSecurityHeaders(app: Express): void {
  const middleware: RequestHandler = (req, res, next) => {
    for (const [name, value] of SECURITY_HEADERS) {
      res.setHeader(name, value);
    }
    // 只有确实是 HTTPS 才发 HSTS；`req.secure` 依赖 trust proxy 设置，
    // 云托管在容器前面有网关，故同时看 `x-forwarded-proto`。
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps =
      req.secure ||
      (typeof forwardedProto === 'string' && forwardedProto.split(',')[0]?.trim() === 'https');
    if (isHttps) {
      for (const [name, value] of HTTPS_ONLY_HEADERS) {
        res.setHeader(name, value);
      }
    }
    next();
  };

  app.use(middleware);
}

/** 供验证脚本比对：CSP 的逐指令值（不做 includes 判断，避免"多一条指令也算过"） */
export function cspDirectives(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of CSP_VALUE.split('; ')) {
    const [key, ...rest] = part.split(' ');
    if (key) result[key] = rest.join(' ');
  }
  return result;
}
