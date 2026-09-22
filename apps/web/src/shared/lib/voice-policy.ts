/**
 * 浏览器**允不允许**用麦克风 —— 策略级前提（`Permissions-Policy` 那一层）。
 *
 * ### 为什么单独成文件
 *
 * 与 `voice-support.ts` / `voice-input.ts` 同一分工口径：
 * - `voice-support.ts` 管「**它是什么、怎么说**」：构造器探测、失败码、面向学生的一句话；
 * - `voice-input.ts` 管「**怎么跑起来**」：会话状态机、定时器、事件接线；
 * - 本文件管「**环境让不让**」：页面所在源的权限策略有没有把麦克风关掉。
 *
 * 拆开也有体积上的原因（门禁 300 行），但更实质的理由是：这是**页面级前提**，
 * 与"浏览器支不支持这个 API"不是一回事 —— 前者的责任方是**部署方**，后者是浏览器。
 * 把两者混在一起，出错时就会把部署问题说成"学生你自己的浏览器不行"。
 *
 * ### 它存在的理由（2026-09-22 线上事故）
 *
 * 服务端那时对**所有响应**发 `Permissions-Policy: microphone=()`，含义是"本站谁都不许用麦克风"。
 * 后果不是"点了报个权限错误"这么轻：浏览器**连授权弹窗都不弹**，直接回 `not-allowed`；
 * 而界面上的提示写着"请在地址栏的权限提示里允许使用麦克风" —— 地址栏**根本没有**那个图标，
 * 学生被引向一条做不了的路，看上去就是"语音功能坏了"。
 *
 * 那个头已改成 `microphone=(self)`（`apps/server/src/http/security-headers.ts`）。
 * 本模块现在是**防回归**：网关、代理，或将来有人"顺手收紧"，界面都能说出真正的原因。
 */

/** 只用到 `allowsFeature`；`document.permissionsPolicy` 与已废弃的 `document.featurePolicy` 都满足 */
export interface PermissionsPolicyLike {
  allowsFeature(feature: string): boolean;
}

/** 本模块需要的最小环境。`VoiceEnvironment` 扩展它 —— 这样两个文件不必互相 import */
export interface PolicyEnvironment {
  /** **仅供测试注入**；生产不传，由本模块自己去 `document` 上取（它不在 `globalThis` 上） */
  permissionsPolicy?: PermissionsPolicyLike | undefined;
}

/** 从 `document` 上取权限策略对象（标准名优先，其次已废弃的 `featurePolicy`） */
function documentPermissionsPolicy(): PermissionsPolicyLike | null {
  const doc = (
    globalThis as {
      document?: {
        permissionsPolicy?: PermissionsPolicyLike;
        featurePolicy?: PermissionsPolicyLike;
      };
    }
  ).document;
  return doc?.permissionsPolicy ?? doc?.featurePolicy ?? null;
}

/**
 * 本站策略**允不允许**用麦克风。读不到就返回 `undefined`（**未知 ≠ 被禁**）。
 *
 * 只在**明确**为 `false` 时才拦：`undefined`（老浏览器没有这个 API，或不认 `microphone`
 * 这个 feature 名）一律当"未知"，交给上游的错误事件回答 —— 不在这里替它下结论。
 */
export function readMicPolicyAllowed(
  env: PolicyEnvironment = globalThis as PolicyEnvironment,
): boolean | undefined {
  const policy = env.permissionsPolicy ?? documentPermissionsPolicy();
  if (policy === null || typeof policy.allowsFeature !== 'function') return undefined;
  try {
    return policy.allowsFeature('microphone');
  } catch {
    return undefined;
  }
}
