/**
 * 左栏导航（L 档改造，2026-09-23）
 *
 * 两组入口，对应「功能 / 对话切换」：
 * - **对话**：主区切到对话流，并显示**当前会话**的真实摘要；
 * - **功能**：材料 / 知识点 / 图谱 / 练习 / 画像 —— 各把主区切到对应面板。
 *
 * ### 为什么左栏**没有**"历史会话列表"
 *
 * 真正的多会话需要服务端能按 `sessionId` 恢复材料与图谱、并有一个列表接口
 * （属 `P2` 的后端与契约变更）。在它落地前，这里**只呈现当前这一个会话** ——
 * 宁可少一个装饰性列表，也不给"看起来有、点了没用"的东西。
 * 「新对话」按钮走的是**既有的** `startNewStudy`（与材料面板里的「开始新学习」是同一个动作），
 * 不做成"新建并保留旧会话"的样子。
 *
 * 徽标（badge）只显示**拿得到的真实数字**：材料份数、知识点数、图谱节点数。
 * 拿不到的一律不显示，不用占位符凑。
 */

import type { Workbench } from '../app/model/workbench-types';
import {
  deriveSessionLabel,
  describeSession,
  formatRelativeDay,
} from '../app/model/conversation';
import { Icon, type IconName } from './Icon';

/** 主区六种视图，与六面板一一对应 */
export type ViewKey = 'chat' | 'material' | 'knowledge' | 'graph' | 'quiz' | 'profile';

export const VIEW_LABELS: Record<ViewKey, string> = {
  chat: '对话',
  material: '材料',
  knowledge: '知识点',
  graph: '图谱',
  quiz: '练习',
  profile: '画像',
};

const FEATURE_ITEMS: { key: Exclude<ViewKey, 'chat'>; icon: IconName }[] = [
  { key: 'material', icon: 'book' },
  { key: 'knowledge', icon: 'bulb' },
  { key: 'graph', icon: 'graph' },
  { key: 'quiz', icon: 'target' },
  { key: 'profile', icon: 'chart' },
];

type Props = {
  wb: Workbench;
  view: ViewKey;
  onViewChange: (view: ViewKey) => void;
};

export function SidebarNav({ wb, view, onViewChange }: Props) {
  const label = deriveSessionLabel(wb);
  const sub = describeSession(wb);

  /* 徽标：只取真实存在的数字，取不到就不显示这一项 */
  const badges: Partial<Record<ViewKey, number>> = {
    material: wb.materials.length,
    knowledge: wb.knowledge?.points.length,
    graph: wb.graph?.nodes.length,
  };

  /* 过往会话：**排除当前这一条**（当前已经在「对话」组里单独显示） */
  const pastEntries = wb.historyEntries.filter((entry) => entry.sessionId !== wb.sessionId);

  /*
   * 时间基准只取一次：若每行各调一次 `new Date()`，同一份列表里的两行会用不同的瞬间，
   * 跨零点时（23:59:59.9 与 00:00:00.1）会出现"一行今天、一行昨天"的错位。
   */
  const now = new Date();

  return (
    <nav className="side" aria-label="导航">
      <div className="side-brand">
        <Icon name="sparkle" size={17} />
        <span>微积分学伴</span>
      </div>

      <button
        className="side-new"
        onClick={() => void wb.startNewStudy()}
        disabled={wb.anyBusy}
        title="会清空当前材料与 AI 补充内容；补充内容不跨会话迁移"
      >
        <Icon name="plus" size={15} />
        新对话
      </button>

      <div className="side-group">
        <div className="side-group-title">对话</div>
        <button
          className={view === 'chat' ? 'side-item side-item-active' : 'side-item'}
          data-view="chat"
          onClick={() => onViewChange('chat')}
          /* 会话状态改到悬停可见（`title`）：常驻在左栏是**冗余小字**，此处一句已够 */
          title={sub}
          aria-current={view === 'chat' ? 'page' : undefined}
        >
          <Icon name="chat" size={16} />
          <span className="side-label">{label}</span>
        </button>
      </div>

      {/*
        本标签页归档的**过往**会话（`P2-2`）—— 刻意**不含当前这一条**（它在上面已经显示）。
        列表为空时整组不出现，不留一个空壳标题。
        ⚠️ 底部那句"仅本标签页保存"是**能力边界的如实标注**，不是装饰性小字：
        `sessionStorage` 关掉标签页就清空，不说明会让人以为这是云端历史。
      */}
      {pastEntries.length > 0 && (
        <div className="side-group">
          <div className="side-group-title">历史会话</div>
          {pastEntries.map((entry) => (
            <button
              key={entry.sessionId}
              className="side-item"
              disabled={wb.anyBusy}
              onClick={() => void wb.switchSession(entry.sessionId)}
              title={`本标签页保存 · 材料 ${entry.materials.length} 份 · 问答 ${entry.history.length} 条`}
            >
              <Icon name="history" size={16} />
              <span className="side-label">{deriveSessionLabel(entry)}</span>
              <span className="side-time">{formatRelativeDay(entry.updatedAt, now)}</span>
            </button>
          ))}
          <div className="side-sub">仅本标签页保存，关闭标签页即清空</div>
        </div>
      )}

      <div className="side-group">
        <div className="side-group-title">功能</div>
        {FEATURE_ITEMS.map((item) => {
          const active = view === item.key;
          const badge = badges[item.key];
          return (
            <button
              key={item.key}
              className={active ? 'side-item side-item-active' : 'side-item'}
              data-view={item.key}
              onClick={() => onViewChange(item.key)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon name={item.icon} size={16} />
              <span className="side-label">{VIEW_LABELS[item.key]}</span>
              {typeof badge === 'number' && badge > 0 && <span className="side-badge">{badge}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
