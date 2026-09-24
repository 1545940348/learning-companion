/**
 * 自编固定题 —— 每主题 3 道，共 9 道（说明书 7.1）
 *
 * 必须标注为「项目自编练习」，不能伪装成上传讲义原题（说明书 2.6）。
 * 数学内容由 B 初审、A 依据核验清单复核；分歧未解决不得进入演示。
 *
 * ### 干扰项的错因标注（`P-B9`，2026-09-23）
 *
 * 每个干扰项带一条人工写下的错因，说明"选它就等于犯了什么错"——这是错题归因里
 * 最强的一层依据（见 `attribution.ts`）。标注本身放在 `fixed-quiz-misconceptions.ts`，
 * 由本文件末尾的 `applyMisconceptions` 并进来，理由见该文件的文件头。
 *
 * ⚠️ **标注只加在干扰项上**：正确选项没有错因可写，接口上也就没有 `misconception` 字段。
 */

import type { QuizItem, QuizOption } from '@lc/contracts';
import { FIXED_QUIZ_MISCONCEPTIONS } from './fixed-quiz-misconceptions.js';

const SOURCE_LABEL = '项目自编练习';

const BASE_QUIZ: Record<string, QuizItem[]> = {
  derivative: [
    {
      id: 'fx-der-1',
      topic: 'derivative',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）函数 f(x) = x² 在 x = 1 处的导数为：`,
      options: [
        { id: 'A', text: '1' },
        { id: 'B', text: '2' },
        { id: 'C', text: '0' },
        { id: 'D', text: '1/2' },
      ],
      answer: 'B',
      explanation: "f'(x) = 2x，代入 x = 1 得 f'(1) = 2。",
    },
    {
      id: 'fx-der-2',
      topic: 'derivative',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）设 f(x) = x²，则当 Δx 趋于 0 时，[f(1 + Δx) − f(1)] / Δx 的极限为：`,
      options: [
        { id: 'A', text: '0' },
        { id: 'B', text: '1' },
        { id: 'C', text: '2' },
        { id: 'D', text: '不存在' },
      ],
      answer: 'C',
      explanation:
        "该式即 f(x) 在 x = 1 处的导数定义式。[f(1 + Δx) − f(1)] / Δx = (1 + 2Δx + Δx² − 1) / Δx = 2 + Δx，令 Δx → 0 得 2。",
    },
    {
      id: 'fx-der-3',
      topic: 'derivative',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）若 f(x) = 3x²，则 f'(2) = ：`,
      options: [
        { id: 'A', text: '6' },
        { id: 'B', text: '12' },
        { id: 'C', text: '3' },
        { id: 'D', text: '24' },
      ],
      answer: 'B',
      explanation: "f'(x) = 6x，代入 x = 2 得 f'(2) = 12。",
    },
  ],

  tangent: [
    {
      id: 'fx-tan-1',
      topic: 'tangent',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）曲线 y = x² 在点 (1, 1) 处的切线斜率为：`,
      options: [
        { id: 'A', text: '1' },
        { id: 'B', text: '2' },
        { id: 'C', text: '0' },
        { id: 'D', text: '−1' },
      ],
      answer: 'B',
      explanation: "切线斜率等于该点导数值。y' = 2x，代入 x = 1 得斜率 2。",
    },
    {
      id: 'fx-tan-2',
      topic: 'tangent',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）曲线 y = x² 在点 (1, 1) 处的切线方程为：`,
      options: [
        { id: 'A', text: 'y = 2x − 1' },
        { id: 'B', text: 'y = 2x + 1' },
        { id: 'C', text: 'y = x' },
        { id: 'D', text: 'y = 2x' },
      ],
      answer: 'A',
      explanation: '由点斜式 y − 1 = 2(x − 1) 整理得 y = 2x − 1。',
    },
    {
      id: 'fx-tan-3',
      topic: 'tangent',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）若函数 y = f(x) 在 x = a 处可导，则曲线在点 (a, f(a)) 处切线的斜率为：`,
      options: [
        { id: 'A', text: 'f(a)' },
        { id: 'B', text: "f'(a)" },
        { id: 'C', text: "f'(a) / a" },
        { id: 'D', text: "1 / f'(a)" },
      ],
      answer: 'B',
      explanation: "导数的几何意义即切线斜率，故斜率为 f'(a)。",
    },
  ],

  monotonicity: [
    {
      id: 'fx-mon-1',
      topic: 'monotonicity',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）函数 f(x) = x³ − 3x 的单调递增区间是：`,
      options: [
        { id: 'A', text: '(−1, 1)' },
        { id: 'B', text: '(−∞, −1) 与 (1, +∞)' },
        { id: 'C', text: '(−∞, −1) 与 (−1, 1)' },
        { id: 'D', text: '(0, +∞)' },
      ],
      answer: 'B',
      explanation:
        "f'(x) = 3x² − 3 = 3(x − 1)(x + 1)。当 x < −1 或 x > 1 时 f'(x) > 0，故递增区间为 (−∞, −1) 与 (1, +∞)。",
    },
    {
      id: 'fx-mon-2',
      topic: 'monotonicity',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）若在区间 I 上恒有 f'(x) > 0，则 f(x) 在 I 上：`,
      options: [
        { id: 'A', text: '单调递减' },
        { id: 'B', text: '单调递增' },
        { id: 'C', text: '先增后减' },
        { id: 'D', text: '无法判断' },
      ],
      answer: 'B',
      explanation: "这是用导数的符号判断单调性的基本结论：f'(x) > 0 时函数单调递增。",
    },
    {
      id: 'fx-mon-3',
      topic: 'monotonicity',
      source: 'fixed',
      stem: `（${SOURCE_LABEL}）函数 f(x) = x³ − 3x 的单调递减区间是：`,
      options: [
        { id: 'A', text: '(−1, 1)' },
        { id: 'B', text: '(−∞, −1)' },
        { id: 'C', text: '(1, +∞)' },
        { id: 'D', text: '(−∞, 0)' },
      ],
      answer: 'A',
      explanation: "f'(x) = 3(x − 1)(x + 1)，当 −1 < x < 1 时 f'(x) < 0，故递减区间为 (−1, 1)。",
    },
  ],
};

/** 标注表的键：`<题目 id>:<选项 id>` */
export function misconceptionKey(itemId: string, optionId: string): string {
  return `${itemId}:${optionId}`;
}

/**
 * 把标注表并进题目。
 *
 * 找不到标注的选项**原样返回**（不带 `misconception`）—— 归因遇到它就会走到"无法归因"，
 * 这是如实的结果，不该由这里补一个。标注写错键（拼错题目 id）在装配时看不出来，
 * 因此 `verify:all` 有一条断言专门核对"27 条标注的键全部命中"，把静默漏标变成红灯。
 */
function applyMisconceptions(quiz: Record<string, QuizItem[]>): Record<string, QuizItem[]> {
  const withTags: Record<string, QuizItem[]> = {};
  for (const [topic, items] of Object.entries(quiz)) {
    withTags[topic] = items.map((item) => ({
      ...item,
      options: item.options.map((option): QuizOption => {
        const tag = FIXED_QUIZ_MISCONCEPTIONS[misconceptionKey(item.id, option.id)];
        return tag ? { ...option, misconception: tag } : option;
      }),
    }));
  }
  return withTags;
}

export const FIXED_QUIZ: Record<string, QuizItem[]> = applyMisconceptions(BASE_QUIZ);
