/**
 * 账号令牌的本地存取（2026-09-23，随演示级账号）。
 *
 * ### 为什么放 `sessionStorage` 而不是 `localStorage`
 *
 * 服务端令牌是**内存态**的（进程重启即失效）。放 `localStorage` 会让"今天存、明天开"
 * 的会话带着一个**已经失效**的令牌，而界面在 `/api/auth/me` 返回之前无法知道它失效 ——
 * 于是首屏必然出现一次"先当成已登录、再掉回未登录"的闪烁。
 * `sessionStorage` 与服务端内存态的生命周期更接近，也沿用项目对会话状态的默认口径
 * （材料与历史会话都用它，见 `app/model/session-history.ts`）。
 *
 * ### 为什么不放 Cookie
 *
 * 令牌走 `X-LC-Token` 请求头。浏览器**不会自动附带**它 ⇒ **不存在 CSRF 面**。
 * 计划书要求"归属校验 ＋ CSRF 必须同批上线"，这里靠"取消 Cookie"让后半句自动成立。
 */

const KEY = 'lc.auth.token.v1';

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    /* 隐私模式 / 存储被禁：当作未登录，不抛给上层 */
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* 写不了的后果仅仅是"刷新后不再登着"，不影响本次会话可用 —— 不打断用户 */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}
