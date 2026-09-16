/**
 * 教学任务 —— 由 B 负责实现与调优
 *
 * 三个任务函数只依赖注入的模型函数，因此脱离网页与托管平台即可测试（说明书 7.2）。
 */

import type {
  AnswerBlock,
  AnswerScope,
  KnowledgePoint,
  NextStep,
  PrerequisiteRelation,
  QuizItem,
  RecentAnswer,
  Topic,
  TutorMode,
} from '@lc/contracts';
import type { ModelCaller } from './model.js';
import {
  SYSTEM_GAP,
  SYSTEM_KNOWLEDGE,
  SYSTEM_QUIZ_FROM_MATERIAL,
  SYSTEM_TUTOR,
} from './prompt.js';

/** 送入模型的材料片段。kind 用于让模型区分讲义与系统补充 */
export interface MaterialSlice {
  id: string;
  kind: 'upload' | 'ai-supplement';
  text: string;
}

function renderMaterials(materials: MaterialSlice[]): string {
  if (materials.length === 0) {
    return '（学生未提供任何材料）';
  }
  return materials
    .map((material) => {
      const label = material.kind === 'ai-supplement' ? '系统补充' : '学生材料';
      return `【${label} ${material.id}】\n${material.text}`;
    })
    .join('\n\n');
}

/** 从模型输出中取出 JSON，容忍 ```json 包裹与前后缀文本 */
function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const source = fenced?.[1] ?? raw;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('模型未返回可解析的 JSON');
  }
  return JSON.parse(source.slice(start, end + 1));
}

/* ============ 知识点与前置依赖抽取 ============ */

export interface AnalyzeKnowledgeInput {
  materials: MaterialSlice[];
}

export interface AnalyzeKnowledgeOutput {
  points: KnowledgePoint[];
  prerequisites: PrerequisiteRelation[];
}

export async function analyzeKnowledge(
  call: ModelCaller,
  input: AnalyzeKnowledgeInput,
): Promise<AnalyzeKnowledgeOutput> {
  const raw = await call(renderMaterials(input.materials), {
    system: SYSTEM_KNOWLEDGE,
    json: true,
  });

  const parsed = extractJson(raw) as Partial<AnalyzeKnowledgeOutput>;
  return {
    points: parsed.points ?? [],
    prerequisites: parsed.prerequisites ?? [],
  };
}

/* ============ 缺口补充 ============ */

export interface SupplementGapInput {
  conceptId: string;
  conceptName: string;
  /** 缺口理由，来自前置关系的 reason */
  reason: string;
  materials: MaterialSlice[];
}

export async function supplementGap(
  call: ModelCaller,
  input: SupplementGapInput,
): Promise<{ content: string }> {
  const prompt = [
    `需要补齐的前置概念：${input.conceptName}（${input.conceptId}）`,
    `判定为缺口的理由：${input.reason}`,
    '',
    '学生当前材料：',
    renderMaterials(input.materials),
  ].join('\n');

  const raw = await call(prompt, { system: SYSTEM_GAP });
  return { content: raw.trim() };
}

/* ============ 按材料出题 ============ */

export interface GenerateQuizInput {
  topic: Topic;
  count: number;
  materials: MaterialSlice[];
}

export async function generateQuizFromMaterial(
  call: ModelCaller,
  input: GenerateQuizInput,
): Promise<QuizItem[]> {
  const prompt = [
    `主题：${input.topic}`,
    `请生成 ${input.count} 道单选题。`,
    '',
    '学生当前材料：',
    renderMaterials(input.materials),
  ].join('\n');

  const raw = await call(prompt, { system: SYSTEM_QUIZ_FROM_MATERIAL, json: true });
  const parsed = extractJson(raw) as { items?: QuizItem[] };
  return parsed.items ?? [];
}

/* ============ 答疑 ============ */

export interface AnswerQuestionInput {
  question: string;
  mode: TutorMode;
  /** 空数组表示零材料提问（轻路径） */
  materials: MaterialSlice[];
  knowledgePointId?: string;
  recentAnswers?: RecentAnswer[];
}

export interface AnswerQuestionOutput {
  scope: AnswerScope;
  blocks: AnswerBlock[];
  basedOnMaterial: boolean;
  nextStep?: NextStep;
}

export async function answerQuestion(
  call: ModelCaller,
  input: AnswerQuestionInput,
): Promise<AnswerQuestionOutput> {
  const lines: string[] = [
    `辅导模式：${input.mode}`,
  ];
  if (input.knowledgePointId) {
    lines.push(`当前聚焦知识点：${input.knowledgePointId}`);
  }
  lines.push('', '学生材料：', renderMaterials(input.materials));

  if (input.recentAnswers && input.recentAnswers.length > 0) {
    lines.push('', '最近的问答（仅作上下文，不要重复作答）：');
    for (const item of input.recentAnswers) {
      lines.push(`问：${item.question}`, `答：${item.answer}`);
    }
  }

  lines.push('', `学生的问题：${input.question}`);

  const raw = await call(lines.join('\n'), { system: SYSTEM_TUTOR, json: true });
  const parsed = extractJson(raw) as Partial<AnswerQuestionOutput>;

  return {
    scope: parsed.scope ?? 'partial',
    blocks: parsed.blocks ?? [],
    // 零材料时明确标记未经材料支撑（说明书 2.1）
    basedOnMaterial: input.materials.length > 0,
    ...(parsed.nextStep ? { nextStep: parsed.nextStep } : {}),
  };
}
