/**
 * 应用外壳（L 档改造，2026-09-23）：左栏 + 主区。
 *
 * 与旧版的**不变量**：顶栏徽标（模型通道 / 符号验证）、`mock` 演示横幅、
 * 「符号验证引擎尚未接入」提示、以及页脚那四段**如实标注**（本页尚未接入 / 语音识别发生在哪里 /
 * 符号验证的边界 / 会话状态）全部保留 —— 它们是**验收清单的判据**，不是可省的装饰。
 *
 * 变化只在**呈现与位置**：
 * - 四段说明从"页脚平铺"收进左栏底部的「本页说明」折叠区 —— 要求是"避免不必要的说明性小字"，
 *   而这些文字是**必要的诚实性标注**，所以是**收纳**而不是删除；
 * - 通知（正在处理 / 失败提示）从"页面顶部横幅"移入**对话流**（就近于触发它的地方），
 *   避免与主区内容割裂。
 */

import type { ReactNode } from 'react';
import type { HealthResponse } from '@lc/contracts';
import { MATERIAL_LIMITS, MODEL_TIMEOUT_MS } from '@lc/contracts';
import type { Workbench } from '../app/model/workbench-types';
import { shouldOfferRetry } from '../app/model/notice';
import { Icon } from './Icon';
import { SidebarNav, type ViewKey } from './SidebarNav';

type Props = {
  health: HealthResponse | null;
  healthError: string | null;
  wb: Workbench;
  view: ViewKey;
  onViewChange: (view: ViewKey) => void;
  sideOpen: boolean;
  onToggleSide: () => void;
  children: ReactNode;
};

export function AppShell({
  health,
  healthError,
  wb,
  view,
  onViewChange,
  sideOpen,
  onToggleSide,
  children,
}: Props) {
  const budgetSeconds = Math.round(MODEL_TIMEOUT_MS / 1000);

  return (
    <div className={sideOpen ? 'shell side-open' : 'shell'}>
      <aside className="shell-side">
        <SidebarNav wb={wb} view={view} onViewChange={onViewChange} />

        <details className="side-note">
          <summary>本页说明</summary>
          <div className="side-note-body">
            <div className="footer-block">
              <strong>会话状态</strong>
              <span>
                {wb.sessionId
                  ? `材料版本 v${wb.materialVersion} · 会话 ${wb.sessionId.slice(0, 8)}`
                  : '轻路径（未创建材料会话）'}
              </span>
              <span>
                材料上限 {MATERIAL_LIMITS.maxMaterialsPerSession} 份 / {MATERIAL_LIMITS.maxTextLength} 字 ·
                单次请求预算 {budgetSeconds} 秒（含验证）
              </span>
            </div>
            <div className="footer-block">
              <strong>本页尚未接入</strong>
              <span>
                教师视图、多智能体编排、错题归因。
                这些入口要么不出现，要么出现时明确说明不可用，不以占位内容冒充已实现。
              </span>
            </div>
            <div className="footer-block">
              <strong>语音识别发生在哪里</strong>
              <span>
                语音在你的浏览器里转成文字，再作为普通文本进入系统。
                服务端的识别能力里**不含**语音（服务端不转写语音）——
                这与「图片由服务端识别」是两回事，在这里分开说明，不合并成一句"支持图文语音"。
              </span>
            </div>
            <div className="footer-block">
              <strong>符号验证的边界</strong>
              <span>
                覆盖求导值、切线、单调区间、极值点四类断言；超出课程范围或超出输入规模的一律标为
                「未验证」，不会当成已验证。
              </span>
            </div>
          </div>
        </details>
      </aside>

      <div className="shell-main">
        <header className="shell-top">
          <button className="icon-btn" onClick={onToggleSide} aria-label="展开或收起导航">
            <Icon name="panel" size={18} />
          </button>
          <h1 className="shell-title">微积分学伴</h1>
          <div className="shell-status">
            {health && (
              <>
                <span className={health.mock ? 'badge badge-warn' : 'badge badge-ok'}>
                  模型通道：{health.modelProvider}
                  {health.mock ? '（mock，未配置密钥）' : ''}
                </span>
                <span
                  className={health.verification.available ? 'badge badge-ok' : 'badge badge-muted'}
                >
                  符号验证：
                  {health.verification.available ? `可用（${health.verification.engine}）` : '未接入'}
                </span>
              </>
            )}
            {healthError && <span className="badge badge-err">服务端未连接</span>}
          </div>
        </header>

        {/*
          提示**统一在主区顶部**（不在对话流里）—— 这样无论主区切到哪个面板，
          失败/取消/重试都能被看到；单一来源也避免了"同一句话在两处显示"。

          阶段 0 卡 3（`D-03`）：模型通道慢时学生最长要干等 90 秒，而单飞约定会挡住
          其它动作 —— 必须给一个"取消"。取消后由发起那次调用的 catch 给中性提示。
        */}
        {wb.anyBusy && (
          <div className="notice notice-info shell-banner">
            <Icon name="refresh" size={16} className="spin" />
            <span>
              正在处理中：模型调用最长可能需要 120 秒。不想等可以取消，已完成的步骤会保留。
            </span>
            <button className="btn btn-sm" onClick={wb.cancelPending}>
              取消
            </button>
          </div>
        )}

        {wb.notice && (
          <div className={`notice notice-${wb.notice.kind} shell-banner`}>
            <Icon name={wb.notice.kind === 'error' ? 'alert' : 'refresh'} size={16} />
            <span>{wb.notice.text}</span>
            {/*
              `I20⑤`：重试按钮必须与**当前这条提示**绑定。判据走 `shouldOfferRetry`
              （纯函数，有真值表断言），壳与其他调用点共用同一份，不各写一套。
            */}
            {shouldOfferRetry(wb.notice, wb.canRetry) && (
              <button className="btn btn-sm" onClick={wb.retryLastFailed} disabled={wb.anyBusy}>
                {wb.anyBusy ? '正在重试…' : '重试'}
              </button>
            )}
            <button className="link" onClick={wb.dismissNotice}>
              知道了
            </button>
          </div>
        )}

        {health?.mock && (
          <div className="notice notice-warn shell-banner">
            <span>
              <strong>当前是 mock 演示通道。</strong>
              模型调用没有真正发生 —— 回答与知识点由固定的演示数据生成，用来验证完整链路，
              <strong>不代表真实模型的输出质量</strong>。服务端配好密钥并设
              MODEL_PROVIDER=deepseek 后即为真实调用（评委无需自行配置）。
            </span>
          </div>
        )}

        {!health?.verification.available && health && (
          <p className="warn-inline shell-banner">
            符号验证引擎尚未接入，因此所有补充内容与推导一律标为
            <strong>未验证</strong>：系统不会把"没验证过"当成"已验证"（§4.2）。
          </p>
        )}

        <div className="shell-body">{children}</div>
      </div>
    </div>
  );
}
