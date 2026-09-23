/**
 * 工作台的状态与动作类型 —— **不含 React 的纯类型模块**。
 *
 * ### 为什么从 `hooks/useWorkbench.ts` 搬到这里（2026-09-23 解耦改造）
 *
 * 原先六面板为了拿类型都写 `import type { … } from '../hooks/useWorkbench'`，
 * 于是 `dependency-cruiser` 的 `panels-should-not-import-state-internals`
 * **6/6 面板全报**：依赖方向与分层相反（presentation → state internals）。
 *
 * 类型是**契约面**，不是"状态的内部实现"。把它独立出来之后：
 * ① 面板不再指向 `hooks/` → 该规则**自然清零**，已按项目惯例（每条规则在自己清零后）
 *    逐条转 `error`，门禁从此有牙齿；② 类型模块不 import React，可以被纯函数模块
 *    （`app/model/sessions.ts`、`app/model/messages.ts`）与验证脚本直接复用；
 * ③ `useWorkbench.ts` 只留实现，体积与职责都更单一。
 *
 * ⚠️ **本文件只放类型**。任何带副作用的实现都要留在 hook 或 model 的纯函数里 ——
 * 否则这里会变成第二个"什么都往里塞"的 useWorkbench。
 */

import type {
  GraphNeighborhood,
  KnowledgePoint,
  LearnerProfile,
  Material,
  PrerequisiteRelation,
  PrerequisiteStatus,
  QuizItem,
  QuizSource,
  Topic,
  TutorMode,
  TutorResponse,
  VerificationStatus,
} from '@lc/contracts';

/**
 * 界面上的一份材料。
 *
 * `corrected` 是**纯界面标记**，不进契约：它表示这份原文已被学生就地纠错，
 * 修正后的内容已作为新材料重新提交（用例 E12 的契约限制见 `correctMaterial`）。
 *
 * `lowConfidence` 来自 `/api/parse`，用于标注"识别可能不准"（§2.2）。
 */
export type UiMaterial = Material & {
  corrected?: boolean;
  /**
   * 图片材料识别到的公式（LaTeX **源码**）。**纯界面字段，不进契约**（与 `corrected` 同理）。
   *
   * ⚠️ **只在图片材料上有值，并且允许为空数组** —— 这两种情况必须分开：
   * - `undefined` = 没走图片路径（手打材料、纠错材料）⇒ 界面对公式**一个字都不该说**；
   * - `[]` = 走了图片路径、识别成功，但**本次没找到公式** ⇒ 要说一句"这张图里没有识别到公式"，
   *   并且**必须说清这不是"通道没接"**（2026-09-22 口径：能力 ≠ 结果）。
   *
   * 混成一个"没有公式"会让纯文字材料也收到一句莫名其妙的提示。
   */
  formulas?: string[];
};

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

/**
 * 一个会话在本标签页里的**归档快照**（`P2-2`，2026-09-23）。
 *
 * ⚠️ 类型住在这里、而不是 `session-history.ts`：它要被 `WorkbenchState.historyEntries` 引用，
 * 而 `WorkbenchState` 在本文件 —— 定义在那边会让两个文件**互相 import**，
 * 触发 `no-circular`（**已是 `error`**；`tsPreCompilationDeps: true` 连 `import type` 也看得见）。
 * **纯函数与存储 IO 仍在 `session-history.ts`，这里只放类型。**
 */
export interface SessionHistoryEntry {
  sessionId: string;
  /** 首次记录时间；左栏用它显示"今天 / 昨天 / 9月20日" */
  createdAt: string;
  /** 最后一次变更时间；列表按它倒序 */
  updatedAt: string;
  materialVersion: number;
  /** **只存文本**（与 `shared/lib/persist.ts` 同一口径：图片不长期保存，识别结果已作为文本入库） */
  materials: { id: string; text: string }[];
  history: TutorTurn[];
}

export interface Notice {
  kind: 'info' | 'warn' | 'error';
  text: string;
  /** 为 true 时界面给「重试」按钮（只在服务端标记 retryable 时为 true） */
  retryable?: boolean;
}

/**
 * 练习提交的上报结果（`I33`）。
 *
 * 存在的理由：面板要如实说明"这次提交有没有真的写进画像"。
 * 拿不到这个信息时，界面只能写一句听起来合理的话 —— 而默认自编题路径
 * **根本没有请求发出**，那句话就是编的。
 */
export type QuizReportOutcome =
  /** 服务端已接受这条画像事件 */
  | 'sent'
  /** 本次练习没有学习会话（自编题路径）→ **没有发出任何请求** */
  | 'no-session'
  /** 发过请求但失败（不阻断练习，§4.5） */
  | 'failed';

export interface WorkbenchState {
  sessionId: string | null;
  materialVersion: number;
  materials: UiMaterial[];
  /** 已提交过 /api/knowledge 的材料文本快照，用于「就地纠错」时对比与重传 */
  knowledge: { points: KnowledgePoint[]; prerequisites: PrerequisiteRelation[] } | null;
  graph: GraphNeighborhood | null;
  gaps: Record<string, GapRecord>;
  history: TutorTurn[];
  /**
   * 本标签页归档的会话（**含当前这一条**），按 `updatedAt` 倒序。
   *
   * ⚠️ **只在当前标签页有效**（`sessionStorage`）—— **关掉标签页即清空**。
   * 界面必须如实说明这一点，不许让人以为这是"云端历史"。
   */
  historyEntries: SessionHistoryEntry[];
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
  /**
   * 上传一张图片作为材料（视觉入口）。
   *
   * 文本由**服务端**从图片识别得到，识别完走与文字材料**完全相同**的下游管道。
   * 返回是否成功，语义与 `submitMaterials` 一致。
   */
  submitImage: (file: File) => Promise<boolean>;
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
   *
   * ### 返回值（`I33`）
   *
   * 面板原先无条件写「本次提交已作为一条画像事件上报」，但默认的「项目自编题」
   * 来源**不会建会话**，`sessionRef.current` 为空 → 函数在开头就 `return`，
   * **根本没有请求发出**。这是无据声明（与 `I20⑦` 同一类）。
   * 因此改为把"到底发生了什么"如实交给调用方，由它决定怎么写：
   * - `'sent'` 服务端已接受这次事件；
   * - `'no-session'` 本次练习没有学习会话（默认自编题路径）→ **没有发出任何请求**；
   * - `'failed'` 发出过请求但失败了（不阻断练习，§4.5）。
   */
  reportQuizAttempt: (payload: {
    topic: Topic;
    source: QuizSource;
    total: number;
    correct: number;
  }) => Promise<QuizReportOutcome>;
  refreshGraph: (knowledgePointId?: string) => Promise<void>;
  fetchProfile: () => Promise<void>;
  startNewStudy: () => Promise<void>;
  /**
   * 切换到**本标签页归档过的**某个会话（`P2-2`，2026-09-23）。
   *
   * 恢复本地快照（材料文本、问答历史、材料版本），再向服务端要一次图谱：
   * - 服务端仍有该会话 → 拿到图谱，**可以继续提问**；
   * - 服务端已重启（会话不存在）→ **如实提示"服务端数据已失效"**，只恢复本地部分，
   *   图谱与缺口状态无法恢复。**不许假装成功**（那是无据声明）。
   */
  switchSession: (sessionId: string) => Promise<void>;
  dismissNotice: () => void;
  /** 由界面直接抛一条提示（如"某入口尚未接入"），避免用 alert 打断操作流 */
  notify: (text: string, kind?: Notice['kind']) => void;
  /** 退出轻路径、进入材料路径：此时才真正创建会话 */
  ensureMaterialSession: () => Promise<string>;
  /** 指定动作是否正在进行 —— **按钮 disabled 用这个** */
  isBusy: (key: ActionKey) => boolean;
  /**
   * 取消当前所有在飞请求（阶段 0 卡 3 / `D-03`）。
   *
   * 为什么要它：`MODEL_TIMEOUT_MS = 90 s` 意味着模型通道慢时学生最长要干等 90 秒，
   * 而单飞约定（`begin()`）会挡住其它动作 —— 没有取消就只能等。
   * 取消后由**发起那次调用的 catch** 给出中性提示（不报错、不给重试按钮），
   * 见 `toNotice` 对 `RequestAbortedError` 的分支。
   */
  cancelPending: () => number;
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

/** 面板与壳组件统一用的组合类型（原来各面板各自写一遍交叉类型） */
export type Workbench = WorkbenchState & WorkbenchActions;
