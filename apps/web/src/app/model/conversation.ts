/**
 * 「对话流」的呈现逻辑 —— **纯函数，不含 React、不碰网络**。
 *
 * 这里回答三个问题，且都能被脚本单独断言（`verify:render` 的真值表节）：
 * 1. 状态怎么变成**消息序列**（`toChatMessages`，正序：最旧在上、最新在下）；
 * 2. 时间怎么显示（`formatClock` / `formatRelativeDay`，都接受 `now` 以便确定性测试）；
 * 3. 左栏那条「当前会话」怎么命名（`deriveSessionLabel` —— **只根据真实存在的字段**，
 *    没有会话时不编一个名字出来）。
 *
 * ⚠️ 本轮**不做多会话历史**：那需要服务端能按 `sessionId` 恢复材料/图谱、并新增列表接口
 * （属 `P2` 的后端与契约变更）。界面因此**只呈现当前这一个会话**，
 * 不给"历史会话列表"这种看起来有、点了没用的东西。
 */

import type { TutorMode } from '@lc/contracts';
import type { TutorTurn } from './workbench-types';

/** 对话流里的一条消息 */
export type ChatMessage =
  /** 学生提的问题 */
  | { kind: 'user'; id: string; text: string; mode: TutorMode; at: string }
  /** 学伴的回答（沿用 `TutorTurn` 的完整结构：块、引用、验证状态、丢弃事实） */
  | { kind: 'answer'; id: string; turn: TutorTurn };

/**
 * 把问答历史摊平成一条消息序列（**正序**：最旧在前、最新在下）。
 *
 * ⚠️ **提示（`notice`）不在这里**：失败/取消/重试的提示由外壳统一渲染在主区顶部，
 * 这样在**任何视图**（材料、图谱、练习…）下都能看到，不会只活在对话视图里。
 * 单一来源也避免了"同一句话在两处显示"。
 */
export function toChatMessages(history: TutorTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of history) {
    messages.push({
      kind: 'user',
      id: `q-${turn.id}`,
      text: turn.question,
      mode: turn.mode,
      at: turn.at,
    });
    messages.push({ kind: 'answer', id: `a-${turn.id}`, turn });
  }
  return messages;
}

/** `HH:MM`（本地时区）。传入非法时间时返回空串，不抛异常、也不显示 `NaN`。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 相对日期标签：`今天` / `昨天` / `M月D日`。
 *
 * 以**自然日**为单位比较（不是"距今 24 小时"），否则 23:59 与次日 00:01 会显示成同一天。
 */
export function formatRelativeDay(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 把问题压成一行短标题（超过 `max` 字用省略号；换行折成空格）。 */
export function summarizeQuestion(text: string, max = 18): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/**
 * 左栏「当前会话」的标题。
 *
 * 取值优先级：**第一个问题 → 第一份材料的前若干字 → 「新对话」**。
 * ⚠️ 这三档都来自**真实存在的状态**；一个都没有时就写「新对话」，
 * 而不是编一个像模像样的名字。
 */
export function deriveSessionLabel(input: {
  history: TutorTurn[];
  materials: { text: string }[];
  sessionId: string | null;
}): string {
  const first = input.history[0];
  if (first) return summarizeQuestion(first.question);
  const firstMaterial = input.materials[0];
  if (firstMaterial) return summarizeQuestion(firstMaterial.text);
  return '新对话';
}

/** 左栏那条会话的副标题：材料版本 / 问答条数 / 是否轻路径。**只报真实值。** */
export function describeSession(input: {
  sessionId: string | null;
  materialVersion: number;
  materials: { text: string }[];
  history: TutorTurn[];
}): string {
  if (!input.sessionId) return '轻路径 · 未创建材料会话';
  return `材料 ${input.materials.length} 份 · 问答 ${input.history.length} 条`;
}

/**
 * 正在进行的动作该怎么写。
 *
 * 返回 `null` 表示没有动作在进行 —— 界面据此**不显示**"正在…"，
 * 而不是显示一个空壳占位。
 */
export function describePending(busy: string | null): string | null {
  switch (busy) {
    case 'knowledge':
      return '正在解析材料并重建图谱…';
    case 'gap':
      return '正在补充缺口…';
    case 'tutor':
      return '正在解答…';
    case 'quiz':
      return '正在出题…';
    case 'profile':
      return '正在读取画像…';
    default:
      return null;
  }
}
