/**
 * 账号与登录（`D7` 口径：**自建演示级、内存态、不做长效 cookie**；2026-09-23 落地）。
 *
 * ### 三件必须说清的事
 *
 * 1. **这不是生产级鉴权。** 账号是**内存态**的、进程重启即失效；
 *    口令由环境变量注入种子（仓库里**不存任何口令明文**）。目标是"演示时能登录并区分角色"，
 *    不是"能扛住攻击"。
 * 2. **令牌走请求头，不走 Cookie** —— 因此**不存在 CSRF 面**（浏览器不会自动附带
 *    `X-LC-Token`）。计划书要求"归属校验 ＋ CSRF 必须同批上线"，这里用**取消 Cookie**的方式
 *    让后半句自动成立，而不是加一个防不住的 CSRF token。
 * 3. **角色只影响"能看到哪些入口"**，不影响数据可见性 ——
 *    教师端看到的是**聚合计数**（`ClassAggregate`），任何角色都取不到个人信息（用例 E17）。
 */

/** `POST /api/auth/login` */
export interface LoginRequest {
  username: string;
  password: string;
}

/** 登录后的账号信息（**不含口令、不含任何可用于认证的凭据**） */
export interface AccountInfo {
  username: string;
  /** 界面上显示的名字 */
  displayName: string;
  /** 角色：学生看学习工作台；教师多一个「教师端」入口 */
  role: 'student' | 'teacher';
  /** 所属班级（演示级：固定 `demo`，与 `aggregateClass` 的口径一致） */
  classId: string;
  /** 本次登录时间（ISO 8601） */
  signedInAt: string;
}

/** `POST /api/auth/login` 响应 */
export interface LoginResponse {
  /** 会话令牌：**内存态**，服务端重启即失效；前端只放在 `sessionStorage` */
  token: string;
  account: AccountInfo;
}

/** `GET /api/auth/me` 响应（未登录时 `account` 为 `null`） */
export interface MeResponse {
  account: AccountInfo | null;
}

/** 演示环境的默认口令提示（界面如实展示，免得演示者不知道输什么） */
export const DEMO_PASSWORD_HINT = 'demo';
