/**
 * 多智能体协作与降级（`P-B8`，2026-09-23）—— B 负责
 *
 * ### 验收判据
 *
 * `todo.md`：**任一 Agent 失败不影响主流程并如实标注**（说明书用例 E18）。
 *
 * ### 四个 Agent 与各自的降级方式（说明书 §4.5）
 *
 * | Agent | 职责 | 失败后 |
 * |---|---|---|
 * | 答疑 `tutor` | 生成解释／提示／完整解答 | **主流程本身** —— 它失败没有可降级的东西 |
 * | 验证 `verifier` | 符号验证、来源校验 | 标「未验证」，主流程继续 |
 * | 诊断 `diagnoser` | 更新画像、识别盲区 | 跳过画像更新，不阻断 |
 * | 出题 `quizzer` | 变式题、按材料出题 | **回落到固定题** |
 *
 * ### 两条不肯让步的规矩
 *
 * 1. **失败必须标注，不许静默**（"不得静默"是 §4.5 的原话）。
 *    每次降级都产出一条 `AgentDegradation`：哪个 Agent、为什么、改用了什么。
 *    界面据此如实告诉学生"这次有一环没跑成"，而不是给一个看起来完整的答案。
 *
 * 2. **降级的方向只能是"更保守"**。验证 Agent 挂了 ⇒ 标 `unverified`，
 *    **绝不**放行成 `verified`。这条不是风格问题：§4.2 要求"未验证内容不得默认视为正确"，
 *    失败时放宽就等于把"没验成"当成了"验过了"。
 *
 * ### 原始错误只进日志，不进面向学生的文案
 *
 * `reason` 是**写好的固定句子**（说明哪一环没跑成），不是 `error.message` ——
 * 上游模型报错里可能带内部地址、参数甚至密钥片段。原始错误经 `onAgentError`
 * 交给调用方（服务端日志），两边各取所需：学生看到实话，运维看到细节。
 *
 * 本模块是**纯编排**：不调模型、不读文件，Agent 一律由调用方注入 ——
 * 因此"某个 Agent 挂掉"这件事可以被直接构造出来测（见 `verify:all` §16）。
 */

import type {
  AgentDegradation,
  AgentRole,
  AnswerBlock,
  ProfileEvent,
  QuizItem,
  VerificationStatus,
} from '@lc/contracts';

/*
 * `AgentRole` / `AGENT_LABELS` / `AgentDegradation` 定义在 `@lc/contracts/src/agents.ts`
 * 并**原样再导出**：降级记录要穿过接口到达界面，形状必须只有一份。
 * 依赖方向仍是 teaching → contracts（与 `MisconceptionKind` 等一致）。
 */
export { AGENT_LABELS } from '@lc/contracts';
export type { AgentDegradation, AgentRole } from '@lc/contracts';

export interface OrchestrateOptions {
  /**
   * 原始错误回调 —— **只有这里能看到真实错误**。
   * 服务端把它写进日志；面向学生的文案一律用固定句子（见文件头）。
   */
  onAgentError?: (agent: AgentRole, error: unknown) => void;
}

/**
 * 跑一个**辅助** Agent：失败不抛，转成一条降级记录。
 *
 * 刻意不做重试：重试是编排层的另一件事（`D-03` 的取消与 §5.4 的可重试都在
 * 请求层解决），这里只负责"失败了怎么办"。把重试混进来会让降级记录变得
 * 难以解释（"失败了"和"重试后仍失败"对学生是同一件事）。
 */
async function runAssistant<T>(
  agent: AgentRole,
  failureReason: string,
  fallbackNote: string,
  run: () => T | Promise<T>,
  options: OrchestrateOptions,
): Promise<{ value: T | null; degradation: AgentDegradation | null }> {
  try {
    return { value: await run(), degradation: null };
  } catch (error) {
    options.onAgentError?.(agent, error);
    return {
      value: null,
      degradation: { agent, reason: failureReason, fallback: fallbackNote },
    };
  }
}

/* ==================== 答疑流程的编排 ==================== */

export interface TutorAgents {
  /**
   * 答疑 Agent —— **主流程**。
   *
   * ⚠️ 它失败时本函数**照常抛出**：E18 说的是"任一 Agent 失败不影响主流程"，
   * 而答疑就是主流程本身，没有可回落的替身。把它也吞掉，学生就会拿到
   * 一个"成功但空"的响应 —— 那才是真正的不如实。
   */
  tutor: () => Promise<AnswerBlock[]>;
  /**
   * 验证 Agent。失败 ⇒ 本次回答标 `unverified`。
   *
   * 可选：不注入时**缺省即 `unverified`**（§4.2 的失败安全方向），
   * 且**不**产生降级记录 —— 没有这个 Agent 不等于它失败了。
   */
  verifier?: () => VerificationStatus | Promise<VerificationStatus>;
  /** 诊断 Agent。失败 ⇒ 跳过画像更新（返回空事件列表） */
  diagnoser?: () => ProfileEvent[] | Promise<ProfileEvent[]>;
}

export interface TutorOrchestration {
  blocks: AnswerBlock[];
  /** 本次回答的可信度；验证 Agent 失败时为 `unverified` */
  verification: VerificationStatus;
  /** 诊断 Agent 产出的画像事件；它失败时为空数组 */
  profileEvents: ProfileEvent[];
  /** 逐条降级记录；一切正常时为空数组 */
  degraded: AgentDegradation[];
}

/**
 * 编排一次答疑：答疑 Agent 必成，验证与诊断两个辅助 Agent 各自独立、失败即降级。
 *
 * 两个辅助 Agent **并行**跑：它们之间没有数据依赖，串行只会让失败互相等待 ——
 * 而"验证 Agent 挂了"本来就不该拖慢"诊断 Agent"。
 */
export async function orchestrateTutor(
  agents: TutorAgents,
  options: OrchestrateOptions = {},
): Promise<TutorOrchestration> {
  /* 主 Agent 先跑且不吞异常：它挂了就没有 answer 可言 */
  const blocks = await agents.tutor();

  const [verification, diagnosis] = await Promise.all([
    agents.verifier
      ? runAssistant(
          'verifier',
          '本次未能完成符号验证（验证环节没有跑成）。',
          '本次回答按「未验证」标注 —— 未验证不等于错，但也不得默认视为正确。',
          agents.verifier,
          options,
        )
      : Promise.resolve({ value: null, degradation: null }),
    agents.diagnoser
      ? runAssistant(
          'diagnoser',
          '本次未能更新学习画像（诊断环节没有跑成）。',
          '本次作答照常给出，只是画像没有跟着更新。',
          agents.diagnoser,
          options,
        )
      : Promise.resolve({ value: null, degradation: null }),
  ]);

  const degraded = [verification.degradation, diagnosis.degradation].filter(
    (item): item is AgentDegradation => item !== null,
  );

  return {
    blocks,
    /*
     * 验证 Agent 缺省或失败都落到 `unverified` —— 这正是 §4.2 要求的**失败安全方向**：
     * 拿不准就标未验证，而不是放行。
     */
    verification: verification.value ?? 'unverified',
    profileEvents: diagnosis.value ?? [],
    degraded,
  };
}

/* ==================== 出题流程的编排 ==================== */

export interface QuizOrchestration {
  items: QuizItem[];
  degraded: AgentDegradation[];
}

/**
 * 编排一次出题：出题 Agent 失败 ⇒ **回落到固定题**（§4.5 原话）。
 *
 * ### 为什么回落到固定题是诚实的
 *
 * 固定题是**项目自编、人工核验过**的题（`verification: 'human'`），
 * 与"按你的材料生成"是两种不同的东西 —— 所以回落时必须**同时改掉来源标注**，
 * 由调用方把 `source` 写成 `'fixed'`。若回落后还标着"基于你的材料生成"，
 * 那就成了冒名（§9 真实性红线），比不给题更糟。
 *
 * `fallback` 由调用方注入（服务端给某主题的固定题），本模块不持有题库 ——
 * 这样"回落"这件事能脱离题库单独测。
 */
export async function orchestrateQuiz(
  quizzer: () => Promise<QuizItem[]>,
  fallback: () => QuizItem[],
  options: OrchestrateOptions = {},
): Promise<QuizOrchestration> {
  const result = await runAssistant(
    'quizzer',
    '按你的材料出题这次没有成功（出题环节没有跑成）。',
    '已回落到「项目自编练习」—— 题不是根据你的材料生成的，来源标注已如实改过来。',
    quizzer,
    options,
  );

  if (result.value !== null && result.value.length > 0) {
    return { items: result.value, degraded: [] };
  }

  /*
   * 出题 Agent **成功但返回空**也走回落：一组空题对学生毫无用处，
   * 而"成功"本身不构成给出空集理由（宁可给 3 道自编题）。
   */
  return { items: fallback(), degraded: result.degradation ? [result.degradation] : [] };
}
