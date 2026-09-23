/**
 * 微积分学伴 · 学习工作台（A）
 *
 * 交互形态（2026-09-23 L 档改造）：**左栏「对话 / 功能」切换 + 主栏对话流**。
 * 两条路径仍共用同一个会话模型（说明书 §2.1）：
 * - **轻路径**：没上传材料时提问，`sessionId` 为 null，回答标注「未基于你的材料」；
 * - **材料路径**：粘贴讲义 → 解析出知识点与前置缺口 → 一键补充 → 分步答疑 → 练习 → 画像。
 *
 * 本文件只做两件事：**取健康状态**、**按视图挑一个面板装进壳里**。
 * 布局细节在 `components/AppShell.tsx`，对话呈现规则在 `app/model/conversation.ts`。
 */

import { useEffect, useState } from 'react';
import type { HealthResponse } from '@lc/contracts';
import { api } from './api';
import { AppShell } from './components/AppShell';
import { AccountView } from './components/AccountView';
import { ConversationView } from './components/ConversationView';
import { GraphPanel } from './components/GraphPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { MaterialPanel } from './components/MaterialPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { QuizPanel } from './components/QuizPanel';
import { TeacherPanel } from './components/TeacherPanel';
import type { ViewKey } from './components/SidebarNav';
import { useWorkbench } from './hooks/useWorkbench';

export function App() {
  const wb = useWorkbench();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('chat');
  /**
   * 窄屏下左栏是抽屉。**宽屏不读这个值**（CSS 媒体查询决定），
   * 所以它在桌面端永远是关的也不影响布局。
   */
  const [sideOpen, setSideOpen] = useState(false);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((error: unknown) => {
        setHealthError(error instanceof Error ? error.message : '无法连接服务端');
      });
    /*
     * 读一次登录身份（演示级账号，2026-09-23）。
     * ⚠️ 它**不阻塞首屏**：未登录也能用学习工作台，所以这里只是"顺带问一下"。
     */
    void wb.loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时问一次，不跟 wb 变
  }, []);

  const mock = health?.mock === true;

  function handleViewChange(next: ViewKey) {
    setView(next);
    /* 抽屉形态下选完即收，省一次点击 */
    setSideOpen(false);
  }

  /*
   * 用户页是**独立一页**：先于 `AppShell` 分支返回，因此不套左栏与主区布局。
   * 理由见 `AccountView` 的注释（"学习动作"与"账号"不是一类东西）。
   */
  if (view === 'account') {
    return <AccountView wb={wb} onBack={() => handleViewChange('chat')} />;
  }

  return (
    <AppShell
      health={health}
      healthError={healthError}
      wb={wb}
      view={view}
      onViewChange={handleViewChange}
      sideOpen={sideOpen}
      onToggleSide={() => setSideOpen((open) => !open)}
    >
      {view === 'chat' && <ConversationView wb={wb} mock={mock} />}
      {view === 'material' && <MaterialPanel wb={wb} mock={mock} />}
      {view === 'knowledge' && <KnowledgePanel wb={wb} />}
      {view === 'graph' && <GraphPanel wb={wb} />}
      {view === 'quiz' && <QuizPanel wb={wb} />}
      {view === 'profile' && <ProfilePanel wb={wb} />}
      {view === 'teacher' && <TeacherPanel wb={wb} />}
    </AppShell>
  );
}
