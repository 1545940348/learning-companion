/**
 * 本标签页的**会话历史归档**（P2-2，2026-09-23）。
 *
 * ### 存什么，为什么存这些
 *
 * 服务端是**内存实现**（说明书 §5.3），所以前端必须自己留一份，才能"回到上一个会话"：
 *
 * - **问答历史**（`TutorTurn[]`）—— **服务端根本不存它**：不存就真的没了；
 * - **材料文本** —— 服务端有该会话时本可不存，但服务端一重启就没了，而且「材料」面板要显示它，
 *   不存会出现"面板是空的、服务端却说你有材料"的错位；
 * - **元信息**（id／时间／版本）—— 左栏那一行要显示它。
 *
 * ### 为什么是 sessionStorage（而不是 localStorage）
 *
 * 与 `shared/lib/persist.ts` 同一口径：说明书要的是"**当前标签页**"。
 * localStorage 会跨标签页共享，两个标签页互相覆盖进度，反而制造会话串扰（用例 E8 的精神）。
 * ⚠️ 代价必须让人知道：**关掉标签页就清空** —— 界面要如实说明，不许让人以为这是"云端历史"。
 *
 * ### 上限（不然 sessionStorage 会被写满）
 *
 * sessionStorage 约 5MB，而一条问答含回答块与引用、可达数 KB。因此设**两个上限**：
 * 最多 {@link MAX_SESSIONS} 个会话、每会话最多 {@link MAX_TURNS} 条问答，超出的丢**最旧**的
 * （保留最近的才有用）。裁剪在**写入前**做，读取侧再兜一次底。
 */

import type { SessionHistoryEntry, TutorTurn } from './workbench-types';

/**
 * ⚠️ **本文件不定义 `SessionHistoryEntry`**（也不定义 `TutorTurn`），而是从 `./workbench-types` 引入。
 *
 * 原因：它需要被 `WorkbenchState.historyEntries` 引用，而 `WorkbenchState` 住在
 * `workbench-types.ts` —— 若把接口定义在这里，两个文件就会**互相 import**，
 * `dependency-cruiser` 的 `no-circular`（**已是 `error`**）会当场报红。
 * 而 `tsPreCompilationDeps: true` 让它连 `import type` 也看得见，所以"类型循环"同样跑不掉。
 *
 * 分工因此是：**类型住 `workbench-types.ts`，本文件只放纯函数与存储 IO**。
 */

/** 最多保留的会话数 */
export const MAX_SESSIONS = 10;
/** 每个会话最多保留的问答条数 */
export const MAX_TURNS = 50;

const KEY = 'lc.sessions.v1';

/** 只保留**最近**的若干条问答（丢最旧的） */
export function trimTurns(history: TutorTurn[], max: number = MAX_TURNS): TutorTurn[] {
  return history.length <= max ? history : history.slice(history.length - max);
}

/**
 * 插入或更新一个会话，并保证**有序 + 有上限**。
 *
 * 排序：`updatedAt` 倒序，并以 `sessionId` 作**平手次级键** —— 同一毫秒更新的两个会话
 * 否则顺序不定，断言会**偶发失败**（看起来像 flaky，其实是排序不确定）。
 */
export function upsertEntry(
  list: SessionHistoryEntry[],
  entry: SessionHistoryEntry,
  max: number = MAX_SESSIONS,
): SessionHistoryEntry[] {
  const next = list.filter((item) => item.sessionId !== entry.sessionId);
  next.push(entry);
  next.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId),
  );
  return next.slice(0, max);
}

export function removeEntry(list: SessionHistoryEntry[], sessionId: string): SessionHistoryEntry[] {
  return list.filter((item) => item.sessionId !== sessionId);
}

/**
 * 解析存储内容 —— **容错优先**：损坏、缺字段、旧格式一律降级为"没有历史"。
 * 绝不因为一条脏数据让整页崩掉（与 `persist.ts` 同一态度）。
 */
export function parseEntries(raw: string | null): SessionHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is SessionHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<SessionHistoryEntry>;
  return (
    typeof item.sessionId === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    typeof item.materialVersion === 'number' &&
    Array.isArray(item.materials) &&
    Array.isArray(item.history)
  );
}

/**
 * 读取归档。
 *
 * ⚠️ 全程 `try/catch`：`sessionStorage` 在**服务端渲染**下不存在（`renderToStaticMarkup`
 * 会执行组件函数体），在隐私模式下也可能直接抛 —— 两种情况下都应安静地降级为"没有历史"。
 */
export function loadEntries(): SessionHistoryEntry[] {
  try {
    return parseEntries(sessionStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveEntries(list: SessionHistoryEntry[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 配额或隐私模式失败：不影响正常使用（与 `persist.ts` 同一处置）
  }
}

export function clearEntries(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 同上
  }
}
