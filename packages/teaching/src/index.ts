/**
 * @lc/teaching —— 独立教学模块
 *
 * 通过注入的模型函数运行（说明书 7.2）：不读密钥、不直接访问网络、不依赖网页或托管平台，
 * 因此可以在没有真实密钥的情况下单测。
 */

import type { AnswerBlock, QuizItem, ValidatedAnswer } from '@lc/contracts';
import type { ModelCaller } from './model.js';
import { answerQuestion, analyzeKnowledge, generateQuizFromMaterial, supplementGap } from './tasks.js';
import type {
  AnalyzeKnowledgeInput,
  AnalyzeKnowledgeOutput,
  AnswerQuestionInput,
  AnswerQuestionOutput,
  GenerateQuizInput,
  SupplementGapInput,
  SupplementGapOutput,
} from './tasks.js';
import { validateAnswerBlocks } from './validate.js';
import type { AllowedRef, ValidateOptions } from './validate.js';

export * from './model.js';
export * from './prompt.js';
export * from './tasks.js';
export * from './validate.js';
export * from './fixed-quiz.js';
export * from './symbolic.js';

export interface TeachingModule {
  answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionOutput>;
  analyzeKnowledge(input: AnalyzeKnowledgeInput): Promise<AnalyzeKnowledgeOutput>;
  supplementGap(input: SupplementGapInput): Promise<SupplementGapOutput>;
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
    generateQuizFromMaterial: (input) => generateQuizFromMaterial(call, input),
    validateAnswerBlocks,
  };
}
