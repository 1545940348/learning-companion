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
  KnowledgePoint,
  LearnerProfile,
  Material,
  PrerequisiteRelation,
  PrerequisiteStatus,
  ProfileEvent,
  QuizItem,
  QuizSource,
  Topic,
  TutorMode,
  TutorResponse,
  VerificationStatus,
} from '@lc/contracts';
import { MATERIAL_LIMITS } from '@lc/contracts';
import { ApiError, api } from '../api';
import { loadProgress, saveProgress } from '../lib/persist';

/**
 * 界面上的一份材料。
 *
 * `corrected` 是**纯界面标记**，不进契约：它表示这份原文已被学生就地纠错，
 * 修正后的内容已作为新材料重新提交（用例 E12 的契约限制见 `correctMaterial`）。
 *
 * `lowConfidence` 来自 `/api/parse`，用于标注"识别可能不准"（§2.2）。
 */
export type UiMaterial = Material & { corrected?: boolean };

/** 正在进行的动作。**门控按钮要用 `isBusy(key)`，不要用 `busy`**（见其注释） */
export type ActionKey = 'knowledge' | 'gap' | 'tutor' | 'quiz' | 'profile';

/**
 * 上一次失败、且服务端标记为可重试的动作。
 *
 * 存**描述符**而不是闭包：闭包会捕获当时的 state（可能已过期），
 * 而描述符在重放时重新走一遍正常流程，用的是最新状态。
 */
export type FailedAction =
  | { kind: 'knowledge'; texts: string[] }
  | { kind: 'gap'; conceptId: string; reason: string }
  | { kind: 'tutor'; question: string; mode: TutorMode }
  | { kind: 'profile' };

/** 一次缺口补充的结果，按 conceptId 归档（§3.4） */
export interface GapRecord {
  content: string;
  supplementBlockId: string;
  status: PrerequisiteStatus;
  verification: VerificationStatus;
}

/** 一条问答历史；带 `stale` 表示其依据已被后续材料更新（用例 E12） */
export interface TutorTurn {
  id: string;
  question: string;
  mode: TutorMode;
  answer: TutorResponse;
  stale: boolean;
  at: string;
}

export interface Notice {
  kind: 'info' | 'warn' | 'error';
  text: string;
  /** 为 true 时界面给「重试」按钮（只在服务端标记 retryable 时为 true） */
  retryable?: boolean;
}

export interface WorkbenchState {
  sessionId: string | null;
  materialVersion: number;
  materials: UiMaterial[];
  /** 已提交过 /api/knowledge 的材料文本快照，用于「就地纠错」时对比与重传 */
  knowledge: { points: KnowledgePoint[]; prerequisites: PrerequisiteRelation[] } | null;
  graph: GraphNeighborhood | null;
  gaps: Record<string, GapRecord>;
  history: TutorTurn[];
  profile: LearnerProfile | null;
  notice: Notice | null;
  /**
   * 最近**开始**的动作，仅用于显示"正在…"的文案。
   *
   * ⚠️ **不要用它门控按钮**：它只记录一个值，两个动作先后开始时会被覆盖，
   * 前一个结束时又会把后一个的忙碌态清掉 —— 这正是原先的缺陷。
   * 门控一律用 `isBusy(key)` / `anyBusy`。
   */
  busy: ActionKey | null;
  /** 是否有任意动作在进行（按钮是否该灰掉看它） */
  anyBusy: boolean;
  /** 是否存在可重试的失败动作 */
  canRetry: boolean;
  /** 最近一次 `/api/parse` 报告的、尚未接入的识别通道（如 `['formula']`） */
  parseUnavailable: string[];
  /**
   * 当前选中的知识点（图谱高亮 + 知识卡片高亮共用）。`null` 表示没有选中。
   *
   * 说明：这只是**界面选择**，不参与六态判定，也不上报服务端 ——
   * 学生看一眼图谱不应该产生任何模型调用或画像事件。
   */
  focusedNodeId: string | null;
}

export interface WorkbenchActions {
  /**
   * 提交材料并重建图谱（可一次传多段）。
   *
   * 返回是否成功 —— 界面据此决定**要不要清空输入框**。
   * §5.4 要求失败时保留学生的输入，成功才清。
   */
  submitMaterials: (texts: string[]) => Promise<boolean>;
  /** 就地纠错：把某份材料改成新文本并重建（用例 E12） */
  correctMaterial: (materialId: string, text: string) => Promise<void>;
  /** 一键补充缺口（§2.3） */
  supplementGap: (conceptId: string, reason: string) => Promise<void>;
  /** 学生选「我已掌握，继续」：只影响引导，不改材料覆盖状态（§2.3） */
  claimKnown: (conceptId: string) => Promise<void>;
  ask: (question: string, mode: TutorMode) => Promise<boolean>;
  loadQuiz: (topic: Topic, source: QuizSource) => Promise<QuizItem[] | null>;
  /**
   * 上报一次练习提交。
   *
   * **只上报 `quiz-attempted`，不上报错题归因**：§2.6 要求归因须给出可核对的理由，
   * 不得仅凭答案对错断言 —— 归因需要诊断 Agent（P1，未实现），
   * 现在硬塞一个"计算错误"到画像里就是编造。
   */
  reportQuizAttempt: (payload: {
    topic: Topic;
    source: QuizSource;
    total: number;
    correct: number;
  }) => Promise<void>;
  refreshGraph: (knowledgePointId?: string) => Promise<void>;
  fetchProfile: () => Promise<void>;
  startNewStudy: () => Promise<void>;
  dismissNotice: () => void;
  /** 由界面直接抛一条提示（如"某入口尚未接入"），避免用 alert 打断操作流 */
  notify: (text: string, kind?: Notice['kind']) => void;
  /** 退出轻路径、进入材料路径：此时才真正创建会话 */
  ensureMaterialSession: () => Promise<string>;
  /** 指定动作是否正在进行 —— **按钮 disabled 用这个** */
  isBusy: (key: ActionKey) => boolean;
  /**
   * 重放上一次失败的动作（§5.4「可重试并保留输入」）。
   *
   * 不覆盖**练习**：`loadQuiz` 的结果由 `QuizPanel` 自己持有，
   * 在这里重放拿到的题目面板收不到。练习的失败由面板上的「换一组」重试。
   */
  retryLastFailed: () => Promise<void>;
  /**
   * 选中 / 取消选中一个知识点（P-A8：卡片 ↔ 图谱联动）。
   *
   * 传 `null` 取消选中。点同一个 id 两次由调用方决定语义（面板里是"再点一次取消"）。
   */
  focusNode: (knowledgePointId: string | null) => void;
}

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
  if (error instanceof ApiError) {
    return { kind: 'error', text: error.message, retryable: error.retryable };
  }
  return { kind: 'error', text: fallback };
}

/** 材料文本合计，用于上限提示（§2.2） */
export function totalTextLength(materials: { text: string }[]): number {
  return materials.reduce((sum, item) => sum + item.text.length, 0);
}

/** 动作的中文名，用于"上一个操作还没完成"这类提示 */
const ACTION_LABELS: Record<ActionKey, string> = {
  knowledge: '解析材料',
  gap: '补充缺口',
  tutor: '解答问题',
  quiz: '获取练习',
  profile: '读取画像',
};

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

        const result = await api.knowledge({ sessionId: id, materials: incoming });
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
          text: `已解析 ${trimmed.length} 段材料，得到 ${result.points.length} 个知识点、${result.prerequisites.length} 条前置关系。`,
        });
        clearFailure();
        return true;
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
      applyVersion,
      begin,
      clearFailure,
      end,
      ensureMaterialSession,
      materials,
      rememberFailure,
      stillCurrent,
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
      await submitMaterials([nextText]);
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
    async (payload: { topic: Topic; source: QuizSource; total: number; correct: number }) => {
      const id = sessionRef.current;
      if (!id) return;
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
      } catch {
        // 画像写入失败不阻断练习（§4.5：任一 Agent 失败不影响主流程）
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
