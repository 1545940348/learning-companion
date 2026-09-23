/**
 * 演示级账号（`D7` 口径：**自建、内存态、不做长效 cookie**；2026-09-23 落地）。
 *
 * ### 为什么是"演示级"而不是"生产级"
 *
 * 目标是**演示时能登录、能区分角色**（学生看工作台、教师多一个教师端入口），
 * 不是"能扛住攻击"。所以：账号是内存态、进程重启即失效；口令由**环境变量注入**，
 * 仓库里**不存任何口令明文**。
 *
 * ### 口令的缺省值必须在界面上说出来
 *
 * 未配置 `LC_DEMO_PASSWORD` 时缺省口令是 `demo`。这个值会由前端**如实标注**
 * （「演示口令：demo」）—— 否则演示者会以为它是"忘了配的"或"某种真密码"。
 * 配了环境变量就按环境变量走。
 *
 * ### 令牌不做 Cookie
 *
 * 令牌经 `X-LC-Token` 请求头传递，**不写 Cookie**。这样浏览器不会自动附带它，
 * 于是**不存在 CSRF 面** —— 计划书要求"归属校验 ＋ CSRF 必须同批上线"，
 * 这里用"取消 Cookie"让后半句自动成立，比加一个防不住的 CSRF token 更实在。
 */

import { randomUUID } from 'node:crypto';
import type { AccountInfo } from '@lc/contracts';

/** 演示级班级 id（与 `store.aggregateClass` 的口径一致：所有会话视为一个班） */
const DEMO_CLASS_ID = 'demo';

const SEED: { username: string; displayName: string; role: AccountInfo['role'] }[] = [
  { username: 'student', displayName: '同学', role: 'student' },
  { username: 'teacher', displayName: '老师', role: 'teacher' },
];

/** 期望口令：环境变量优先，缺省 `demo`（缺省值由界面如实标注） */
function expectedPassword(): string {
  return process.env.LC_DEMO_PASSWORD ?? 'demo';
}

/**
 * 校验用户名口令。成功返回账号信息（**不含口令**），失败返回 `null`。
 *
 * ⚠️ 这里**不做**时序攻击防护（不比较哈希耗时常数）：演示级账号没有可猜的敏感数据，
 * 加 `timingSafeEqual` 只会让人误以为它是生产级实现。**如实保持简单**。
 */
export function authenticate(username: string, password: string): AccountInfo | null {
  const seed = SEED.find((item) => item.username === username);
  if (!seed) return null;
  if (password !== expectedPassword()) return null;
  return { ...seed, classId: DEMO_CLASS_ID, signedInAt: new Date().toISOString() };
}

/* ==================== 内存态令牌表 ==================== */

/**
 * `token → 账号`。
 *
 * ⚠️ **进程重启即失效** —— 这是刻意的（`D7` 定的"内存态、不做长效 cookie"）。
 * 前端把 token 放在 `sessionStorage`；服务端重启后 `/api/auth/me` 返回 `null`，
 * 界面据此回到未登录态并**如实说明**"服务端已重启，需要重新登录"，
 * 而不是静默失败、也不是假装还登着。
 */
const tokens = new Map<string, AccountInfo>();

/** 签发令牌。同一账号可并存多个令牌（演示级不做出踢下线） */
export function issueToken(account: AccountInfo): string {
  const token = randomUUID();
  tokens.set(token, account);
  return token;
}

export function resolveToken(token: string | undefined): AccountInfo | null {
  return token ? (tokens.get(token) ?? null) : null;
}

export function revokeToken(token: string | undefined): void {
  if (token) tokens.delete(token);
}
