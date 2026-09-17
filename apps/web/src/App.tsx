/**
 * 微积分学伴 · 学习工作台（A）
 *
 * 两条路径共用一个页面（说明书 §2.1）：
 * - **轻路径**：没上传材料时提问，`sessionId` 为 null，回答标注「未基于你的材料」；
 * - **材料路径**：粘贴讲义 → 解析出知识点与前置缺口 → 一键补充 → 分步答疑 → 练习 → 画像。
 *
 * 页面对「尚未实现的能力」一律如实标注，不用占位内容充数（§9）。
 */

import { useEffect, useState } from 'react';
import type { HealthResponse } from '@lc/contracts';
import { MATERIAL_LIMITS, MODEL_TIMEOUT_MS } from '@lc/contracts';
import { api } from './api';
import { GraphPanel } from './components/GraphPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { MaterialPanel } from './components/MaterialPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { QuizPanel } from './components/QuizPanel';
import { TutorPanel } from './components/TutorPanel';
import { useWorkbench } from './hooks/useWorkbench';

export function App() {
  const wb = useWorkbench();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((error: unknown) => {
        setHealthError(error instanceof Error ? error.message : '无法连接服务端');
      });
  }, []);

  const budgetSeconds = Math.round(MODEL_TIMEOUT_MS / 1000);

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>微积分学伴</h1>
          <p className="subtitle">
            导数 · 切线 · 单调性 ｜ 先回答你的问题，问不出来时替你找出缺的那一块
          </p>
        </div>
        <div className="status">
          {health && (
            <>
              <span className={health.mock ? 'badge badge-warn' : 'badge badge-ok'}>
                模型通道：{health.modelProvider}
                {health.mock ? '（mock，未配置密钥）' : ''}
              </span>
              <span className={health.verification.available ? 'badge badge-ok' : 'badge badge-muted'}>
                符号验证：{health.verification.available ? `可用（${health.verification.engine}）` : '未接入'}
              </span>
            </>
          )}
          {healthError && <span className="badge badge-err">服务端未连接</span>}
        </div>
      </header>

      {health?.mock && (
        <div className="notice notice-warn">
          <span>
            <strong>当前是 mock 演示通道。</strong>
            模型调用没有真正发生 —— 回答与知识点由固定的演示数据生成，用来验证完整链路，
            <strong>不代表真实模型的输出质量</strong>。服务端配好密钥并设
            MODEL_PROVIDER=deepseek 后即为真实调用（评委无需自行配置）。
          </span>
        </div>
      )}

      {!health?.verification.available && health && (
        <p className="warn-inline">
          符号验证引擎尚未接入，因此所有补充内容与推导一律标为
          <strong>未验证</strong>：系统不会把"没验证过"当成"已验证"（§4.2）。
        </p>
      )}

      {wb.notice && (
        <div className={`notice notice-${wb.notice.kind}`}>
          <span>{wb.notice.text}</span>
          {wb.canRetry && (
            <button className="btn btn-sm" onClick={wb.retryLastFailed} disabled={wb.anyBusy}>
              {wb.anyBusy ? '正在重试…' : '重试'}
            </button>
          )}
          <button className="link" onClick={wb.dismissNotice}>
            知道了
          </button>
        </div>
      )}

      <main className="layout">
        <div className="column">
          <MaterialPanel wb={wb} mock={health?.mock === true} />
          <KnowledgePanel wb={wb} />
          <GraphPanel wb={wb} />
        </div>
        <div className="column">
          <TutorPanel wb={wb} mock={health?.mock === true} />
          <QuizPanel wb={wb} />
          <ProfilePanel wb={wb} />
        </div>
      </main>

      <footer className="footer">
        <div className="footer-block">
          <strong>会话状态</strong>
          <span>
            {wb.sessionId ? `材料版本 v${wb.materialVersion} · 会话 ${wb.sessionId.slice(0, 8)}` : '轻路径（未创建材料会话）'}
          </span>
          <span>
            材料上限 {MATERIAL_LIMITS.maxMaterialsPerSession} 份 / {MATERIAL_LIMITS.maxTextLength} 字 ·
            单次请求预算 {budgetSeconds} 秒（含验证）
          </span>
        </div>
        <div className="footer-block">
          <strong>本页尚未接入</strong>
          <span>
            图片与语音识别、符号验证引擎、教师视图、多智能体编排、错题归因。
            这些入口要么不出现，要么出现时明确说明不可用，不以占位内容冒充已实现。
          </span>
        </div>
      </footer>
    </div>
  );
}
