/**
 * 练习 —— 对应说明书 2.6
 *
 * 两组题：固定题（兜底、可校验）与按材料生成题（贴合学生材料）。
 */

import type { Citation, VerificationStatus } from './knowledge.js';
import type { LearnerProfile, MisconceptionKind } from './profile.js';

/** 课程范围严格限定为三个主题 */
export type Topic = 'derivative' | 'tangent' | 'monotonicity';

export const TOPIC_LABELS: Record<Topic, string> = {
  derivative: '导数',
  tangent: '切线',
  monotonicity: '单调性',
};

/**
 * 题目来源
 * - fixed    项目自编固定题，须标注身份，不能伪装成上传讲义原题
 * - material 基于当前会话材料生成，属来源类别 ②
 * - variant  按**学生画像里的薄弱概念**生成的变式题（`P-B17`，2026-09-23 新增）
 *
 * ⚠️ `variant` 与另两者的差别不在"谁出的"，而在**出题依据是个人画像** ——
 * 因此题目本身**不得暴露个人数据**（不写"因为你答错过"这类话，见出题提示词第 4 条）。
 */
export type QuizSource = 'fixed' | 'material' | 'variant';

export interface QuizOption {
  id: string;
  text: string;
  /**
   * 干扰项**预标注的错因**（`P-B9`，2026-09-23；加性可选）。
   *
   * ### 为什么错因要写在选项上，而不是等答错后再去问模型
   *
   * §2.6 的红线是「不得仅凭答案对错断言」—— 学生的选项本身就是**最强的证据**：
   * 选了 `0` 而不是 `2`，说明他把"极限为 0"当成了结论；这不是推测，是**逐条可查**的。
   * 把这条标注随选项一起给出，归因的理由就**不需要**由模型现编。
   *
   * ### 只有自编题带标注
   *
   * 它由项目人工撰写（与固定题的 `verification: 'human'` 同源）。
   * 按材料／变式生成的题**没有**这个字段 —— 那些题的归因走结构推导或诊断 Agent，
   * 拿不到就如实返回"无法归因"，**不编一个错因**。
   */
  misconception?: {
    kind: MisconceptionKind;
    /**
     * 这个坑的**短名字**，用作画像里「常见误区」的累计键（`P-B9`）。
     *
     * ### 为什么必须人工写，不能从 `reason` 里现抠
     *
     * 画像要做的是**跨题累计**：同一个坑在不同题目上被踩中两次，`count` 才该是 2。
     * 而这个累计需要一个**跨题稳定**的键 —— `reason` 是逐题的完整句子（提到具体的
     * 数字、具体的点），天然不可能跨题相同；从句子自动摘出短名字则是**摘要**，
     * 摘歪了就会把两个不同的坑并成一个（或把一个坑裂成两个），而这两种错误都**看不出来**。
     *
     * 所以短名字与 `reason` 一样由出题人写下，并且**同一类错误在相关题目上复用同一个词**
     * （如 `fx-tan-1:A` 与 `fx-tan-3:A` 都是「把函数值当导数值」）——
     * 这样 `count` 的累加才是真的在数"同一个坑踩了几次"。
     */
    pattern: string;
    /** 可核对理由：要说清"选它就等于犯了什么错" */
    reason: string;
  };
}

export interface QuizItem {
  id: string;
  topic: Topic;
  source: QuizSource;
  stem: string;
  options: QuizOption[];
  /** 仅在学生提交后由前端展示（说明书 2.6） */
  answer?: string;
  explanation?: string;
  /** 解析所用规则的依据 */
  citations?: Citation[];
  /**
   * 验证状态（V2.0 §5.3：练习输出含验证状态）。
   * 固定题由服务端标为 `human`（自编题经人工核验）；
   * 按材料生成的题缺省 `unverified`，不得默认视为正确。
   */
  verification?: VerificationStatus;
}

/* ============ 错题归因（`P-B9`，2026-09-23） ============ */

/**
 * 归因是**怎么得出来的** —— 这个字段决定了理由有多可核对，必须如实回报。
 *
 * 三层的可核对性依次递减，因此**不允许**把后两层的产物说成第一层。
 */
export type AttributionBasis =
  /** ① 干扰项预标注：理由就是那条人工写下的标注，逐条可查（最强） */
  | 'option-tag'
  /** ② 结构推导：由「所选选项 vs 正确选项」**算**出的差量（区间包含、数值符号／倍数） */
  | 'structural'
  /** ③ 诊断 Agent（模型）：产物一律 `unverified`，且必须校验到具体选项才采纳（最弱） */
  | 'diagnostic-agent';

/**
 * 一次错题的归因结论。
 *
 * ### 为什么 `evidence` 是必需的
 *
 * §2.6 要求「不得仅凭答案对错断言」。`evidence` 把**核对所需的两侧原文**一起带上 ——
 * 学生（与复核者）不需要相信归因，可以当场拿这两句自己比一遍。
 * 没有能力提供 `evidence` 的实现，就不该返回归因，而应返回 `null`。
 */
export interface QuizAttribution {
  kind: MisconceptionKind;
  /**
   * 这个坑的短名字 —— 画像里「常见误区」的累计键（跨题稳定，同坑同名才累加）。
   * 层 ① 取自干扰项预标注，层 ② 由集合关系直接给出（都是**定值**，不是摘要）。
   */
  pattern: string;
  /** 可核对理由：**必须指向题目里的具体一处**，不写"理解不到位"这类没法判的话 */
  reason: string;
  basis: AttributionBasis;
  /** 核对材料：选中的与正确的两侧原文 */
  evidence: {
    selectedOptionId: string;
    selectedText: string;
    correctOptionId: string;
    correctText: string;
  };
  /**
   * 归因本身的可信度。
   * ① → `human`（人工标注）；② → `symbolic`（一次可复算的推导）；③ → `unverified`。
   */
  verification: VerificationStatus;
}

/* ============ 提交一次练习（`P-B9`，2026-09-23） ============ */

/**
 * 学生的一次选择。
 *
 * ⚠️ **只送 `itemId` + 选中的选项 id，不送题干与选项正文**。
 * 归因要用到的两侧原文，由**服务端**按 `itemId` 从自编题库里取 ——
 * 让客户端把"正确答案是什么"一起送上来，等于把判分与归因的依据交给了被评估方，
 * 那样得到的归因再"可核对"也没有意义。
 *
 * 因此**只有服务端认得的题（自编题）能被归因**；按材料/变式生成的题不在题库里，
 * 提交后归因一律为 `null`，并计入 `unattributed` —— 这是如实的结果，不是缺陷。
 */
export interface QuizAttemptAnswer {
  itemId: string;
  selectedOptionId: string;
}

export interface QuizAttemptResult {
  itemId: string;
  correct: boolean;
  /**
   * 归因结论。
   *
   * `null` 有**两种**含义，界面必须分开说，不得混为一谈：
   * - 答对了（归因只描述"错在哪"，对正确作答没有可说的）；
   * - 答错了但**推不出**（无预标注、也做不出结构推导）—— 此时应如实讲"无法归因"。
   *   把后一种说成"你已经掌握"是失真（§2.6）。
   */
  attribution: QuizAttribution | null;
}

export interface QuizAttemptRequest {
  sessionId: string;
  answers: QuizAttemptAnswer[];
}

export interface QuizAttemptResponse {
  results: QuizAttemptResult[];
  /** 更新后的画像：错因按 `kind + pattern` 累计进 `misconceptions` */
  profile: LearnerProfile;
  /**
   * 本批**答错但没能归因**的题数。
   *
   * 单独回报而不是让前端自己数：前端只知道 `attribution === null`，
   * 分不清"答对了"与"推不出"，而这个数字正是界面用来如实说明的比例分母。
   */
  unattributed: number;
}

/** 固定题每题主题的道数（说明书 2.6） */
export const FIXED_QUIZ_PER_TOPIC = 3;

/** 按材料生成题的道数 */
export const MATERIAL_QUIZ_PER_TOPIC = 2;
