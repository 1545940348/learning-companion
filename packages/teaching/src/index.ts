/**
 * @lc/teaching —— 独立教学模块
 *
 * 通过注入的模型函数运行（说明书 7.2）：不读密钥、不直接访问网络、不依赖网页或托管平台，
 * 因此可以在没有真实密钥的情况下单测。
 */

import type { AnswerBlock, QuizItem, ValidatedAnswer } from '@lc/contracts';
import type { ModelCaller } from './model.js';
import {
  answerQuestion,
  analyzeKnowledge,
  generateQuizFromMaterial,
  supplementGap,
  /* 与方法名同名，导入时改名以避免遮蔽（方法是"已绑定 caller"的那一层） */
  supplementGapWithCorrection as runSupplementWithCorrection,
} from './tasks.js';
import type {
  AnalyzeKnowledgeInput,
  AnalyzeKnowledgeOutput,
  AnswerQuestionInput,
  AnswerQuestionOutput,
  GenerateQuizInput,
  SupplementGapInput,
  SupplementGapOutput,
  SupplementVerification,
  SupplementWithCorrectionResult,
} from './tasks.js';
import { validateAnswerBlocks } from './validate.js';
import type { AllowedRef, ValidateOptions } from './validate.js';

export * from './model.js';
export * from './prompt.js';
export * from './tasks.js';
export * from './validate.js';
export * from './fixed-quiz.js';
export * from './latex.js';
export * from './symbolic.js';

export interface TeachingModule {
  answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionOutput>;
  analyzeKnowledge(input: AnalyzeKnowledgeInput): Promise<AnalyzeKnowledgeOutput>;
  supplementGap(input: SupplementGapInput): Promise<SupplementGapOutput>;
  /**
   * 带**失败修正回环**的缺口补充（`P-B2`，2026-09-23）。
   *
   * 与 `supplementGap` 只差一件事：验证 `failed` 时会把失败原因回喂模型**再生成一次**。
   * 校验函数由调用方注入（服务端传 `symbolic.ts` 的 `verifySupplementContent`）——
   * 这样这条回环能**脱离符号引擎单独测**（传一个假的 verify 就能覆盖三种分支）。
   *
   * ⚠️ **重试过 ≠ 通过**：第二次仍 `failed` 就还是 `failed`，调用方照常落 `DISPUTED`。
   */
  supplementGapWithCorrection(
    input: SupplementGapInput,
    verify: (draft: { content: string; claims: unknown[] }) => SupplementVerification,
  ): Promise<SupplementWithCorrectionResult>;
  generateQuizFromMaterial(input: GenerateQuizInput): Promise<QuizItem[]>;
  validateAnswerBlocks(
    blocks: AnswerBlock[],
    refs: AllowedRef[],
    options?: ValidateOptions,
  ): ValidatedAnswer;
}

/** 绑定模型函数，得到教学模块实例 */
export function createTeachingModule(call: ModelCaller): TeachingModule {
  return {
    answerQuestion: (input) => answerQuestion(call, input),
    analyzeKnowledge: (input) => analyzeKnowledge(call, input),
    supplementGap: (input) => supplementGap(call, input),
    supplementGapWithCorrection: (input, verify) =>
      runSupplementWithCorrection(call, input, verify),
    generateQuizFromMaterial: (input) => generateQuizFromMaterial(call, input),
    validateAnswerBlocks,
  };
}
