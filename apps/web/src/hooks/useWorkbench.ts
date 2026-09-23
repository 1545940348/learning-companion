/**
 * 工作台状态与动作 —— A 的核心状态层（说明书 §2.1—2.6、§5.4）
 *
 * ### 三件必须做对的事
 *
 * 1. **版本护栏**（§5.4「响应仅在会话与版本匹配时应用」）：
 *    发出请求时记下当时的 `materialVersion`，回来时若版本已变，**丢弃结果**并告知学生，
 *    而不是把基于旧材料的回答渲染到新材料上（用例 E8）。
 * 2. **错误可重试要如实传达**：服务端返回的 `retryable` 决定是否给「重试」按钮（§5.4）。
 * 3. **轻路径与材料路径共用一个会话模型**：轻路径就是 `sessionId === null`
 *    （§2.1），不另起一套状态，避免两套逻辑漂移。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GraphNeighborhood,
  LearnerProfile,
  Material,
  PrerequisiteRelation,
  PrerequisiteStatus,
  ProfileEvent,
  QuizItem,
  QuizSource,
  Topic,
  TutorMode,
} from '@lc/contracts';
import { MATERIAL_LIMITS } from '@lc/contracts';
import { ApiError, RequestAbortedError, api, cancelInFlightRequests, describeAbort } from '../api';
import { clearProgress, loadProgress, saveProgress } from '../shared/lib/persist';
import { readImageFile } from '../shared/lib/image-input';
import { totalTextLength } from '../app/model/materials';

/**
 * 类型已搬到 `app/model/workbench-types.ts`（2026-09-23 解耦改造）。
 *
 * 为什么要搬：六面板原先为了拿类型都 `import type … from '../hooks/useWorkbench'`，
 * `dependency-cruiser` 的 `panels-should-not-import-state-internals` 于是 **6/6 全报**
 * （presentation → state internals）。类型是**契约面**、不是状态内部实现，
 * 独立成模块后该规则清零并已按项目惯例转 `error`。
 *
 * 这里**原样再导出**，既有调用点（含 `scripts/verify-render.tsx`）继续可用；
 * **新代码请直接从 `app/model/workbench-types` 引**，不要再往本文件加类型。
 */
import type {
  ActionKey,
  FailedAction,
  GapRecord,
  Notice,
  QuizReportOutcome,
  TutorTurn,
  UiMaterial,
  WorkbenchActions,
  WorkbenchState,
} from '../app/model/workbench-types';

export type {
  ActionKey,
  FailedAction,
  GapRecord,
  Notice,
  QuizReportOutcome,
  TutorTurn,
  UiMaterial,
  Workbench,
  WorkbenchActions,
  WorkbenchState,
} from '../app/model/workbench-types';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 画像事件在**请求**里必须带 `sessionId`。
 *
 * ⚠️ 契约上 `ProfileEvent.sessionId` 是必填，但服务端 `guardProfileEvents` 会用请求里的
 * `sessionId` 覆盖它 —— 也就是说该字段在请求侧是冗余的。
 * 这里把冗余收敛到一处：等契约细分为 `ProfileEventInput`（不含 sessionId）后，
 * 只需改这一个函数，不必去翻 4 个调用点。
 */
type ProfileEventInput = Omit<ProfileEvent, 'sessionId'>;

function withSessionId(sessionId: string, events: ProfileEventInput[]): ProfileEvent[] {
  return events.map((event) => ({ ...event, sessionId }));
}

function toNotice(error: unknown, fallback: string): Notice {
  /*
   * 阶段 0 卡 3：中止必须**分成两类**再决定怎么说（`describeAbort` 是纯函数，有断言）。
   * 超时 → 失败提示 + 可重试；取消 → 中性提示、**不给重试按钮**
   * （学生自己按的取消不该被渲染成"你失败了"）。
   */
  if (error instanceof RequestAbortedError) {
    const described = describeAbort(error.kind);
    return error.kind === 'timeout'
      ? { kind: 'error', text: described.text, retryable: described.retryable }
      : { kind: 'info', text: described.text };
  }
  if (error instanceof ApiError) {
    if (error.code === 'NOT_FOUND') {
      /*
       * 清理时机 ②（阶段 0 卡 4 / `D-06`）：会话已不存在 → 本地快照必须清掉。
       *
       * 服务端的会话是**内存态**（云托管缩容或重启即全部消失），而本地
       * sessionStorage 里的快照会活得更久 —— 于是"刷新恢复"会恢复出一个
       * **指向不存在会话的幽灵会话**：材料显示着、但每次操作都 404。
       * 提示里要说清"为什么"，否则学生只会觉得"这功能坏了"。
       */
      clearProgress();
      return {
        kind: 'warn',
        text: `${error.message}（服务端会话已不存在或已重启，本地保存的进度已清理，请重新提交材料）`,
      };
    }
    return { kind: 'error', text: error.message, retryable: error.retryable };
  }
  return { kind: 'error', text: fallback };
}

/**
 * 材料文本合计 —— 已移到 `app/model/materials.ts`（2026-09-23 解耦改造）。
 *
 * 移动原因：`MaterialPanel` 需要它，而 `components → hooks` 的依赖方向被
 * `panels-should-not-import-state-internals` 禁止。这里保留**再导出**。
 */
export { totalTextLength } from '../app/model/materials';

/** 动作的中文名，用于"上一个操作还没完成"这类提示 */
const ACTION_LABELS: Record<ActionKey, string> = {
  knowledge: '解析材料',
  gap: '补充缺口',
  tutor: '解答问题',
  quiz: '获取练习',
  profile: '读取画像',
};

/**
 * 是否展示「重试」按钮 —— 已移到 `app/model/notice.ts`（2026-09-23 解耦改造）。
 *
 * 移动原因：外壳组件（`components/AppShell.tsx`）也要用这条判据，而
 * `components → hooks` 的依赖方向被 `panels-should-not-import-state-internals` 禁止。
 * 这里保留**再导出**，让既有调用点（含 `scripts/verify-render.tsx` 的真值表断言）继续可用。
 */
export { shouldOfferRetry } from '../app/model/notice';

export function useWorkbench(): WorkbenchState & WorkbenchActions {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [materialVersion, setMaterialVersion] = useState(0);
  const [materials, setMaterials] = useState<UiMaterial[]>([]);
  const [knowledge, setKnowledge] = useState<WorkbenchState['knowledge']>(null);
  const [graph, setGraph] = useState<GraphNeighborhood | null>(null);
  const [gaps, setGaps] = useState<Record<string, GapRecord>>({});
  const [history, setHistory] = useState<TutorTurn[]>([]);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [pending, setPending] = useState<ActionKey[]>([]);
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const [parseUnavailable, setParseUnavailable] = useState<string[]>([]);
  /**
   * 图谱与知识卡片**共用**的选中知识点（P-A8 联动高亮）。
   *
   * 放在状态层而不是面板内部：两个面板是并列的兄弟节点，卡片上的一次点击要让图谱定位过去，
   * 组件局部 state 传不过去 —— 各存一份必然退化成"两套选择"，点卡片后图谱还停在上一个。
   */
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  /**
   * 版本护栏的锚点。
   *
   * 用 ref 而不是 state：请求发出后要在回调里读"当前的"版本，
   * 用 state 会读到闭包里的旧值，护栏形同虚设。
   */
  const versionRef = useRef(0);
  const sessionRef = useRef<string | null>(null);

  /**
   * 正在进行中的动作集合。
   *
   * 用 ref 作为事实来源：`begin`/`end` 可能在同一次事件里被连续调用，
   * 只靠 state 会读到上一次渲染的旧值。
   */
  const pendingRef = useRef<Set<ActionKey>>(new Set());

  /**
   * 开始一个动作。**同一时间只允许一个动作修改状态**。
   *
   * 为什么单飞：多个动作并行时会各自 `setState` 一大片工作台状态
   * （材料、版本、图谱、问答历史），互相覆盖后对不上的组合是没法解释的。
   * 素材解析与缺口补充同时改 `materialVersion` 尤其危险。
   */
  const begin = useCallback((key: ActionKey): boolean => {
    if (pendingRef.current.size > 0) {
      const running = [...pendingRef.current].map((item) => ACTION_LABELS[item]).join('、');
      setNotice({
        kind: 'warn',
        text: `上一个操作（${running}）还没有完成，请稍候 —— 同时进行多个操作会让状态对不上。`,
      });
      return false;
    }
    pendingRef.current.add(key);
    setPending([...pendingRef.current]);
    setBusy(key);
    return true;
  }, []);

  const end = useCallback((key: ActionKey) => {
    pendingRef.current.delete(key);
    const remaining = [...pendingRef.current];
    setPending(remaining);
    // 清除自己的忙碌态即可；此时按单飞约定 remaining 必为空
    setBusy((previous) => (previous === key ? null : previous));
  }, []);

  /** 动作成功后清掉"可重试"标记 */
  const clearFailure = useCallback(() => setFailedAction(null), []);

  /**
   * 记录一次失败。**只有服务端说 `retryable` 才允许重试**（§5.4）。
   *
   * 不可重试的失败（如 400 入参错误）记下来只会误导学生反复点。
   */
  const rememberFailure = useCallback(
    (action: FailedAction, next: Notice) => {
      setNotice(next);
      setFailedAction(next.retryable === true ? action : null);
    },
    [],
  );

  /* ---------- 刷新恢复（§5.4：当前标签页保存进度，刷新可恢复） ---------- */

  useEffect(() => {
    const saved = loadProgress();
    if (!saved) return;
    setSessionId(saved.sessionId);
    sessionRef.current = saved.sessionId;
    setMaterialVersion(saved.materialVersion);
    versionRef.current = saved.materialVersion;
    setMaterials(
      saved.materials.map((item) => ({
        id: item.id,
        kind: 'upload' as const,
        text: item.text,
        createdAt: saved.savedAt,
      })),
    );
    setNotice({
      kind: 'info',
      text: '已从本标签页恢复上次的材料与进度。图谱与问答需要重新解析一次材料才会回来。',
    });
  }, []);

  // 持久化：只存文本，**图片不长期保存**（§5.4）
  useEffect(() => {
    if (!sessionId) return;
    saveProgress({
      sessionId,
      materialVersion,
      materials: materials.map((item) => ({ id: item.id, text: item.text })),
      savedAt: new Date().toISOString(),
    });
  }, [sessionId, materialVersion, materials]);

  /**
   * 清理时机 ③（阶段 0 卡 4 / `D-06`）：**页面卸载时清掉学生材料原文**。
   *
   * 材料原文（可能含个人信息或内部教材）原先**只写不清**：`clearProgress()` 全仓无调用点。
   * 用 `pagehide` 而不是 `beforeunload`：前者在移动端与"进后台"时也会触发，
   * 且 `beforeunload` 在部分浏览器里要求同步处理、容易被忽略。
   * 演示场景里评委关掉标签页即不留原文。
   */
  useEffect(() => {
    const onHide = () => {
      clearProgress();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  /** 当前版本是否仍是发出请求时的版本（§5.4 护栏） */
  const stillCurrent = useCallback((versionAtRequest: number): boolean => {
    if (versionAtRequest !== versionRef.current) {
      setNotice({
        kind: 'warn',
        text: '材料在这期间更新过，这次的结果基于旧材料，已丢弃以免误导。',
      });
      return false;
    }
    return true;
  }, []);

  const applyVersion = useCallback((next: number) => {
    versionRef.current = next;
    setMaterialVersion(next);
  }, []);

  const ensureMaterialSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const session = await api.createSession();
    sessionRef.current = session.id;
    setSessionId(session.id);
    applyVersion(session.materialVersion);
    setGraph({
      sessionId: session.id,
      materialVersion: session.materialVersion,
      rootConceptId: null,
      nodes: session.graph.nodes,
      edges: session.graph.edges,
    });
    return session.id;
  }, [applyVersion]);

  /* ---------- 材料提交 / 图谱重建（§2.2、§2.4） ---------- */

  /**
   * 剥掉**纯界面字段**再上行，保证发出去的载荷与契约里写的 `Material` 逐字一致。
   *
   * `corrected` / `formulas` 只活在界面上（契约里没有这两个字段）。服务端会忽略未知字段，
   * 所以"顺手发过去"也能跑 —— 但那样"界面状态"与"线上载荷"就不是一套事实了，
   * 而这类漂移正是本项目反复吃过亏的地方（`I14`）。显式列出字段，多一行，换一个确定。
   */
  function toWireMaterial(material: UiMaterial): Material {
    return {
      id: material.id,
      kind: material.kind,
      text: material.text,
      ...(material.lowConfidence !== undefined ? { lowConfidence: material.lowConfidence } : {}),
      createdAt: material.createdAt,
    };
  }

  /**
   * 材料入库：调 `/api/knowledge`，并把返回的图谱 / 版本 / 材料同步进界面状态。
   *
   * **纯提取**（2026-09-21，自 `submitMaterials` 原样搬出，**行为不变**）：
   * 文字材料与**图片材料**（视觉接入后新增的入口）走的是**同一条下游管道**，
   * 两处各写一遍必然漂移 —— 那正是 `I14`「两套事实」的成因。
   * 因此只保留这一份，两个入口都调它；`submitMaterials` 只是少了一段内联代码。
   */
  const commitMaterialsToSession = useCallback(
    async (id: string, incoming: UiMaterial[], versionAtRequest: number): Promise<boolean> => {
      const result = await api.knowledge({
        sessionId: id,
        materials: incoming.map(toWireMaterial),
      });
      if (!stillCurrent(versionAtRequest)) return false;

      setMaterials((previous) => [...previous, ...incoming]);
      applyVersion(result.materialVersion);
      setKnowledge({ points: result.points, prerequisites: result.prerequisites });
      setGraph({
        sessionId: result.sessionId,
        materialVersion: result.materialVersion,
        rootConceptId: null,
        nodes: result.graph.nodes,
        edges: result.graph.edges,
      });
      // 材料变了：已有回答的依据可能不再成立（用例 E12）
      setHistory((previous) => previous.map((turn) => ({ ...turn, stale: true })));
      // 同理，旧的选中项可能已不存在于新图谱里 —— 清掉，避免高亮一个不存在的节点
      setFocusedNodeId(null);
      setNotice({
        kind: 'info',
        text:
          `已解析 ${incoming.length} 段材料，得到 ${result.points.length} 个知识点、` +
          `${result.prerequisites.length} 条前置关系。`,
      });
      clearFailure();
      return true;
    },
    [applyVersion, clearFailure, stillCurrent],
  );

  const submitMaterials = useCallback(
    async (texts: string[]): Promise<boolean> => {
      const trimmed = texts.map((text) => text.trim()).filter((text) => text.length > 0);
      if (trimmed.length === 0) {
        setNotice({ kind: 'warn', text: '请先粘贴要解析的内容。' });
        return false;
      }

      const incomingLength = trimmed.reduce((sum, text) => sum + text.length, 0);
      const total = totalTextLength(materials) + incomingLength;
      if (total > MATERIAL_LIMITS.maxTextLength) {
        setNotice({
          kind: 'error',
          text:
            `材料文本合计不能超过 ${MATERIAL_LIMITS.maxTextLength} 字：` +
            `已有 ${totalTextLength(materials)} 字，本次 ${incomingLength} 字，` +
            `合计 ${total} 字。请缩短内容或开始新学习。`,
        });
        return false;
      }

      if (!begin('knowledge')) return false;
      try {
        const id = await ensureMaterialSession();
        const versionAtRequest = versionRef.current;

        /*
         * 先过识别层 `/api/parse`（§2.2）。
         *
         * 为什么不让前端直接把文本包成 Material：识别层才是产出
         * 「公式 LaTeX」与「识别可能不准」片段的地方。现在它只回文本，
         * 但 B5 接入公式识别后，这里不必再改就能把 `lowConfidence` 渲染出来。
         * 逐条 parse 而不是拼成一条：`lowConfidence` 的偏移量是相对**单份材料**的，
         * 拼接后偏移会错位。
         */
        const unavailable = new Set<string>();
        const incoming: Material[] = [];
        for (const text of trimmed) {
          const parsed = await api.parse({ text });
          for (const item of parsed.unavailable ?? []) unavailable.add(item);
          incoming.push({
            id: newId(),
            kind: 'upload',
            text: parsed.text,
            ...(parsed.lowConfidence.length > 0 ? { lowConfidence: parsed.lowConfidence } : {}),
            createdAt: new Date().toISOString(),
          });
        }
        setParseUnavailable([...unavailable]);

        return await commitMaterialsToSession(id, incoming, versionAtRequest);
      } catch (error) {
        rememberFailure(
          { kind: 'knowledge', texts: trimmed },
          toNotice(error, '材料解析失败，请稍后重试。'),
        );
        return false;
      } finally {
        end('knowledge');
      }
    },
    [
      begin,
      commitMaterialsToSession,
      end,
      ensureMaterialSession,
      materials,
      rememberFailure,
    ],
  );

  /**
   * 图片材料（视觉入口，2026-09-21 接入）。
   *
   * 与 `submitMaterials` 的差别**只在前半段**：文本由**服务端**从图片识别得到
   * （`POST /api/parse` 的视觉路径，见 `apps/server/src/parse/vision.ts`）；
   * 拿到文本之后就是一份普通材料，下游完全复用 `commitMaterialsToSession`，
   * **不另起一条管道**。
   *
   * 两条与文字路径不同的处置，都写在代码里而不是留给读者猜：
   * - **总量闸门放在识别之后**：图片材料有多长，只有识别完才知道；
   * - **不注册"重试"**：失败可能发生在识别之前（读盘 / 超限 / 不是图片），
   *   那时并没有文本可留作 `rememberFailure` 的依据。留一份假文本比不留更糟，
   *   所以失败后让学生重新选图（`retryLastFailed` 只覆盖文字材料）。
   */
  const submitImage = useCallback(
    async (file: File): Promise<boolean> => {
      const read = await readImageFile(file);
      if (!read.ok) {
        setNotice({ kind: 'warn', text: read.problem });
        return false;
      }

      if (!begin('knowledge')) return false;
      try {
        const id = await ensureMaterialSession();
        const versionAtRequest = versionRef.current;

        // 识别：图片 → 文本（服务端经已接入的模型通道完成，非本机推断）
        const parsed = await api.parse({ imageBase64: read.base64 });

        const recognized = parsed.text.trim();
        if (recognized.length === 0) {
          setNotice({
            kind: 'warn',
            text: '这张图片没有识别出可用的文字，请换一张更清晰的图片，或直接把文字粘贴进来。',
          });
          return false;
        }

        const total = totalTextLength(materials) + recognized.length;
        if (total > MATERIAL_LIMITS.maxTextLength) {
          setNotice({
            kind: 'error',
            text:
              `材料文本合计不能超过 ${MATERIAL_LIMITS.maxTextLength} 字：` +
              `已有 ${totalTextLength(materials)} 字，本次识别出 ${recognized.length} 字。` +
              `请缩短内容或开始新学习。`,
          });
          return false;
        }

        setParseUnavailable(parsed.unavailable ?? []);

        /*
         * 公式（LaTeX）**存下来**（2026-09-22，"省事路"）。
         *
         * 模型在图片路径上**早就在给** `formulas`（见 `apps/server/src/parse/vision.ts` 的
         * `VISION_SYSTEM_PROMPT`），但这里原先只取 `parsed.text`，值被直接丢掉 ——
         * 于是"公式识别"看上去像完全没接。现在按 LaTeX **源码**展示（不做排版渲染，
         * 因此不引任何依赖，也不动 CSP）。
         *
         * ⚠️ **空数组也要存**：`[]`＝"识别成功、但本次没找到公式"，与 `undefined`
         * （压根没走图片路径）在界面上说法不同，见 `UiMaterial.formulas` 的说明。
         */
        const formulas = (parsed.formulas ?? []).map((item) => item.latex);

        const incoming: UiMaterial[] = [
          {
            id: newId(),
            kind: 'upload',
            text: recognized,
            // 识别可能不准的片段照常带上，界面会标出来（§2.2）
            ...(parsed.lowConfidence.length > 0 ? { lowConfidence: parsed.lowConfidence } : {}),
            formulas,
            createdAt: new Date().toISOString(),
          },
        ];
        return await commitMaterialsToSession(id, incoming, versionAtRequest);
      } catch (error) {
        setNotice(toNotice(error, '图片识别失败，请重试，或直接把文字粘贴进来。'));
        return false;
      } finally {
        end('knowledge');
      }
    },
    [
      begin,
      commitMaterialsToSession,
      end,
      ensureMaterialSession,
      materials,
    ],
  );

  /**
   * 就地纠错（用例 E12）。
   *
   * ⚠️ **契约限制**：`POST /api/knowledge` 只支持**追加**材料，没有"替换某一份"的字段。
   * 因此这里的做法是：把修正后的文本作为**新材料**提交并重建图谱，
   * 前端把被修正的旧材料标记为「已修正」。
   *
   * 已知缺口：旧文本仍留在会话材料集中参与解析。彻底解决需要契约支持
   * 按 materialId 替换（已记录，待 C 评估）。
   */
  const correctMaterial = useCallback(
    async (materialId: string, text: string) => {
      const nextText = text.trim();
      if (nextText.length === 0) {
        setNotice({ kind: 'warn', text: '修正后的内容不能为空。' });
        return;
      }
      const target = materials.find((item) => item.id === materialId);
      if (!target || target.text === nextText) return;

      setMaterials((previous) =>
        previous.map((item) =>
          item.id === materialId ? { ...item, text: nextText, corrected: true } : item,
        ),
      );
      /*
       * `I20③`：**先看结果再宣告**。
       *
       * 原先无条件写「已按修正后的内容重建知识点与依赖关系」，即使
       * `submitMaterials` 失败（超长、识别层报错、版本冲突…）也照写 ——
       * 成功文案会把失败提示直接顶掉，学生以为改好了；
       * 更麻烦的是本地文本已经改成新内容、服务端仍是旧的，两边不是一套事实。
       * 现在失败即回滚本地修正，并把失败提示留在界面上（由 submitMaterials 抛出）。
       */
      const rebuilt = await submitMaterials([nextText]);
      if (!rebuilt) {
        setMaterials((previous) =>
          previous.map((item) =>
            item.id === materialId ? { ...item, text: target.text, corrected: target.corrected } : item,
          ),
        );
        return;
      }
      setNotice({
        kind: 'info',
        text: '已按修正后的内容重建知识点与依赖关系，先前的回答已标记「依据已更新」。',
      });
    },
    [materials, submitMaterials],
  );

  /* ---------- 缺口补充（§2.3、E6） ---------- */

  const supplementGap = useCallback(
    async (conceptId: string, reason: string) => {
      if (!begin('gap')) return;
      try {
        const id = await ensureMaterialSession();
        const versionAtRequest = versionRef.current;
        const result = await api.gap({
          sessionId: id,
          materialVersion: versionAtRequest,
          conceptId,
          reason,
        });
        if (!stillCurrent(versionAtRequest)) return;

        setGaps((previous) => ({
          ...previous,
          [conceptId]: {
            content: result.content,
            supplementBlockId: result.supplementBlockId,
            status: result.status,
            verification: result.verification,
          },
        }));
        applyVersion(result.materialVersion);
        clearFailure();
        void api
          .profile({
            sessionId: id,
            events: withSessionId(id, [
              { type: 'gap-supplemented', conceptId, at: new Date().toISOString() },
            ]),
          })
          .then(setProfile)
          .catch(() => undefined);
      } catch (error) {
        rememberFailure(
          { kind: 'gap', conceptId, reason },
          toNotice(error, '补充失败，原有材料与状态已保留。'),
        );
      } finally {
        end('gap');
      }
    },
    [applyVersion, begin, clearFailure, end, ensureMaterialSession, rememberFailure, stillCurrent],
  );

  const claimKnown = useCallback(
    async (conceptId: string) => {
      const id = sessionRef.current;
      if (!id) return;
      setNotice({
        kind: 'info',
        text: '已记下「我已掌握」。这不会改变材料覆盖状态 —— 材料里没有的东西不会因为点一下就算有。',
      });
      try {
        const next = await api.profile({
          sessionId: id,
          events: withSessionId(id, [
            { type: 'gap-claimed-known', conceptId, at: new Date().toISOString() },
          ]),
        });
        setProfile(next);
      } catch {
        // 画像写入失败不影响主流程（§4.5：任一 Agent 失败不影响主流程）
      }
    },
    [],
  );

  /* ---------- 答疑（§2.5） ---------- */

  const ask = useCallback(
    async (question: string, mode: TutorMode): Promise<boolean> => {
      const trimmed = question.trim();
      if (trimmed.length === 0) {
        setNotice({ kind: 'warn', text: '请先写下你的问题。' });
        return false;
      }

      if (!begin('tutor')) return false;
      try {
        const id = sessionRef.current;
        const versionAtRequest = id ? versionRef.current : 0;
        const answer = await api.ask({
          sessionId: id,
          materialVersion: versionAtRequest,
          question: trimmed,
          mode,
        });
        if (id && !stillCurrent(versionAtRequest)) return false;

        setHistory((previous) => [
          ...previous,
          {
            id: newId(),
            question: trimmed,
            mode,
            answer,
            stale: false,
            at: new Date().toISOString(),
          },
        ]);
        clearFailure();

        if (id) {
          void api
            .profile({
              sessionId: id,
              events: withSessionId(id, [
                {
                  type: 'question-asked',
                  at: new Date().toISOString(),
                  payload: { topic: 'monotonicity', hasFormula: /[=<>'′²]/.test(trimmed) },
                },
              ]),
            })
            .then(setProfile)
            .catch(() => undefined);
        }
        return true;
      } catch (error) {
        rememberFailure(
          { kind: 'tutor', question: trimmed, mode },
          toNotice(error, '解答失败，请稍后重试。你的输入没有被清空。'),
        );
        return false;
      } finally {
        end('tutor');
      }
    },
    [begin, clearFailure, end, rememberFailure, stillCurrent],
  );

  /* ---------- 练习（§2.6） ---------- */

  const loadQuiz = useCallback(
    async (topic: Topic, source: QuizSource): Promise<QuizItem[] | null> => {
      /*
       * 「按我的材料出题」在零材料时必须**拒绝**，不能静默建会话（`I20⑥`）。
       *
       * 原实现无条件走 `ensureMaterialSession()`：会话被悄悄建出来，
       * 服务端拿空材料去出题，返回的题却被标成 `source: 'material'`，
       * 前端据此显示「基于你的材料生成」—— 而题目与学生的材料毫无关系。
       * 这里在发出请求之前就拦住，并说清该怎么继续。
       */
      if (source === 'material' && materials.length === 0) {
        setNotice({
          kind: 'warn',
          text: '还没有可用的材料，无法按材料出题。请先在「材料」面板提交讲义，或改用「项目自编题」（不依赖材料）。',
        });
        return null;
      }

      if (!begin('quiz')) return null;
      try {
        const id = source === 'material' ? await ensureMaterialSession() : undefined;
        const result = await api.quiz({
          topic,
          source,
          ...(id ? { sessionId: id } : {}),
        });
        clearFailure();
        return result.items;
      } catch (error) {
        // 练习的重试不走全局重试：题目列表由 QuizPanel 持有，
        // 在 hook 里重放拿到的题目面板收不到。面板上的「换一组」就是它的重试。
        setNotice(toNotice(error, '获取练习失败，请稍后重试。'));
        return null;
      } finally {
        end('quiz');
      }
    },
    [begin, clearFailure, end, ensureMaterialSession, materials],
  );

  /* ---------- 图谱与画像 ---------- */

  const reportQuizAttempt = useCallback(
    async (payload: {
      topic: Topic;
      source: QuizSource;
      total: number;
      correct: number;
    }): Promise<QuizReportOutcome> => {
      const id = sessionRef.current;
      // I33：自编题路径没有会话 → 这里**没有发出任何请求**，必须如实告诉界面
      if (!id) return 'no-session';
      try {
        const next = await api.profile({
          sessionId: id,
          events: withSessionId(id, [
            {
              type: 'quiz-attempted',
              at: new Date().toISOString(),
              payload: { ...payload },
            },
          ]),
        });
        setProfile(next);
        return 'sent';
      } catch {
        // 画像写入失败不阻断练习（§4.5：任一 Agent 失败不影响主流程）
        return 'failed';
      }
    },
    [],
  );

  const refreshGraph = useCallback(
    async (knowledgePointId?: string) => {
      const id = sessionRef.current;
      if (!id) {
        setNotice({ kind: 'warn', text: '还没有材料会话，图谱为空。' });
        return;
      }
      try {
        const neighborhood = await api.graph(id, knowledgePointId);
        setGraph(neighborhood);
      } catch (error) {
        setNotice(toNotice(error, '读取图谱失败。'));
      }
    },
    [],
  );

  const fetchProfile = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) {
      setNotice({ kind: 'warn', text: '还未开始材料路径，画像暂无内容。' });
      return;
    }
    if (!begin('profile')) return;
    try {
      const next = await api.profile({ sessionId: id, events: [] });
      setProfile(next);
      clearFailure();
    } catch (error) {
      rememberFailure({ kind: 'profile' }, toNotice(error, '读取画像失败。'));
    } finally {
      end('profile');
    }
  }, [begin, clearFailure, end, rememberFailure]);

  /* ---------- 开始新学习（§2.4） ---------- */

  const startNewStudy = useCallback(async () => {
    if (!begin('knowledge')) return;
    try {
      const session = await api.createSession();
      sessionRef.current = session.id;
      setSessionId(session.id);
      applyVersion(session.materialVersion);
      setMaterials([]);
      setKnowledge(null);
      setGaps({});
      setHistory([]);
      setProfile(null);
      setParseUnavailable([]);
      // 新会话的图谱是空的，旧的选中项没有任何意义
      setFocusedNodeId(null);
      clearFailure();
      /*
       * 清理时机 ①（阶段 0 卡 4 / `D-06`）：新会话已建好 → 明确清掉旧的本地快照。
       *
       * 刻意放在**创建成功之后**：创建失败时旧快照仍能用于"刷新恢复"，
       * 先清会让一次网络抖动变成"进度全丢"。也不依赖"下一次覆盖写"——
       * 覆盖写失败（配额/隐私模式）时旧原文会一直在。
       */
      clearProgress();
      setGraph({
        sessionId: session.id,
        materialVersion: session.materialVersion,
        rootConceptId: null,
        nodes: session.graph.nodes,
        edges: session.graph.edges,
      });
      setNotice({
        kind: 'info',
        // 说明书 §3.4：AI 补充内容不跨会话迁移，新会话中同一概念回到 MISSING
        text: '已开始新的学习。材料、图谱与 AI 补充内容都不迁移，之前补过的概念在新会话里仍算「材料未覆盖」。',
      });
    } catch (error) {
      // 新建会话失败不给「重试」：按钮本来就在，再点一次即可；
      // 而把 startNewStudy 记进可重试动作会引入自引用（它自己要处理重试）。
      setNotice(toNotice(error, '新建会话失败。'));
    } finally {
      end('knowledge');
    }
  }, [applyVersion, begin, clearFailure, end]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const notify = useCallback((text: string, kind: Notice['kind'] = 'info') => {
    setNotice({ kind, text });
  }, []);

  /**
   * 选中一个知识点（P-A8）。
   *
   * 纯界面动作：不发请求、不写画像、不产生 notice —— 仅仅是"看一眼"，
   * 不该有任何副作用，也不该被 `begin`/`end` 的忙碌态门控。
   */
  const focusNode = useCallback((knowledgePointId: string | null) => {
    setFocusedNodeId(knowledgePointId);
  }, []);

  /**
   * 重放上一次失败的动作（§5.4「可超时可重试并保留输入」）。
   *
   * 定义在**所有动作之后**：这样闭包拿到的是它们当前的实现，
   * 不必用 ref 绕一圈。重放走的是正常流程，用最新状态。
   */
  const retryLastFailed = useCallback(async () => {
    const action = failedAction;
    if (!action) return;
    setFailedAction(null);
    switch (action.kind) {
      case 'knowledge':
        await submitMaterials(action.texts);
        break;
      case 'gap':
        await supplementGap(action.conceptId, action.reason);
        break;
      case 'tutor':
        await ask(action.question, action.mode);
        break;
      case 'profile':
        await fetchProfile();
        break;
    }
  }, [ask, failedAction, fetchProfile, submitMaterials, supplementGap]);

  const isBusy = useCallback((key: ActionKey) => pending.includes(key), [pending]);

  /**
   * 取消所有在飞请求（阶段 0 卡 3）。返回被取消的数量。
   *
   * 这里**刻意不发提示**：取消是学生主动动作，提示交给发起那次调用的 `catch`
   * （它会走 `toNotice` 的中性分支）。两处都发就会出现两条提示。
   */
  const cancelPending = useCallback(() => cancelInFlightRequests(), []);

  return {
    sessionId,
    materialVersion,
    materials,
    knowledge,
    graph,
    gaps,
    history,
    profile,
    notice,
    busy,
    anyBusy: pending.length > 0,
    canRetry: failedAction !== null,
    parseUnavailable,
    focusedNodeId,
    submitMaterials,
    submitImage,
    correctMaterial,
    supplementGap,
    claimKnown,
    ask,
    loadQuiz,
    reportQuizAttempt,
    refreshGraph,
    fetchProfile,
    startNewStudy,
    dismissNotice,
    notify,
    cancelPending,
    ensureMaterialSession,
    isBusy,
    retryLastFailed,
    focusNode,
  };
}

/** 供界面使用的派生值：把图谱状态与补充记录合成学生看到的六态 */
export function effectiveStatus(
  relation: PrerequisiteRelation,
  gaps: Record<string, GapRecord>,
): PrerequisiteStatus {
  const gap = gaps[relation.conceptId];
  return gap ? gap.status : relation.status;
}
