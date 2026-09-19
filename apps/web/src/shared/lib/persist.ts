/**
 * 当前标签页的进度持久化（说明书 §5.4）。
 *
 * 约束：
 * - 保存**材料文本、图谱、进度**，刷新可恢复；
 * - **图片不长期保存** —— 因此持久化时只留文本，图片识别结果作为文本入库；
 * - 只存当前标签页（sessionStorage 语义上更贴近"本标签页"，但其跨刷新保留、
 *   关闭标签页即清除，正好符合"当前标签页保存"的表述）。
 *
 * 为什么不放 localStorage：说明书要求的是"当前标签页"，而 localStorage 会跨标签页
 * 共享，两个标签页互相覆盖进度，反而制造出会话串扰的观感（用例 E8 的精神）。
 */

const KEY = 'lc.workbench.v2';

/** 可持久化的进度快照（**不含图片**） */
export interface PersistedProgress {
  sessionId: string;
  materialVersion: number;
  /** 仅文本材料 */
  materials: { id: string; text: string }[];
  /** 材料文本合计长度，用于恢复后立即显示上限占用 */
  savedAt: string;
}

export function loadProgress(): PersistedProgress | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedProgress>;
    if (typeof parsed.sessionId !== 'string') return null;
    if (typeof parsed.materialVersion !== 'number') return null;
    if (!Array.isArray(parsed.materials)) return null;
    return {
      sessionId: parsed.sessionId,
      materialVersion: parsed.materialVersion,
      materials: parsed.materials.filter(
        (item): item is { id: string; text: string } =>
          typeof item?.id === 'string' && typeof item?.text === 'string',
      ),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    // 存储被禁用或内容损坏：静默降级为"没有可恢复的进度"，不阻断使用
    return null;
  }
}

export function saveProgress(progress: PersistedProgress): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // 配额或隐私模式失败：不影响正常使用
  }
}

export function clearProgress(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 同上
  }
}
