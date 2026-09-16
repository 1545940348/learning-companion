/**
 * 模型适配器 —— C 负责实现与验证（说明书 5.1、C2）
 *
 * 对外只暴露 ModelCaller，教学模块不关心底层是哪家模型。
 * 未配置密钥时自动使用 mock，使 A 能独立开发前端（说明书 8.2）。
 */

import type { ModelCaller, ModelCallOptions } from '@lc/teaching';
import { env } from '../env.js';

export interface ModelAdapter {
  name: string;
  isMock: boolean;
  call: ModelCaller;
}

/* ==================== mock 适配器 ==================== */

/**
 * mock 用于无密钥联调。它按提示词中的模块标识返回结构化假数据，
 * 并复用演示案例：单调性材料缺少导数解释 → MISSING，
 * 一旦出现系统补充块则转为 SUPPLEMENTED，便于前端验证完整闭环。
 */
function createMockAdapter(): ModelAdapter {
  return {
    name: 'mock',
    isMock: true,
    call: async (prompt, options) => mockRespond(prompt, options),
  };
}

/** 从提示词中还原材料 ID，使 mock 的引用能通过校验 */
function parseRefIds(prompt: string): { materialIds: string[]; supplementIds: string[] } {
  const materialIds: string[] = [];
  const supplementIds: string[] = [];
  const pattern = /【(学生材料|系统补充)\s*([^】\s]+)】/g;
  for (const match of prompt.matchAll(pattern)) {
    const [, label, id] = match;
    if (!id) continue;
    if (label === '系统补充') supplementIds.push(id);
    else materialIds.push(id);
  }
  return { materialIds, supplementIds };
}

function mockRespond(prompt: string, options?: ModelCallOptions): string {
  const system = options?.system ?? '';
  const { materialIds, supplementIds } = parseRefIds(prompt);
  const zeroMaterial = prompt.includes('（学生未提供任何材料）');

  if (system.includes('备课模块')) {
    return mockKnowledge(supplementIds.length > 0);
  }
  if (system.includes('补充模块')) {
    return MOCK_SUPPLEMENT;
  }
  if (system.includes('出题模块')) {
    return mockGeneratedQuiz(materialIds);
  }
  return mockTutor(materialIds, zeroMaterial);
}

function mockKnowledge(dependencySupplied: boolean): string {
  return JSON.stringify({
    points: [
      {
        id: 'kp-monotonicity',
        name: '单调性',
        explanation:
          "利用导数的符号判断函数在区间上的增减：f'(x) > 0 时函数在该区间单调递增，f'(x) < 0 时单调递减。",
        formula: "f'(x) > 0 ⇒ f(x) 在区间内单调递增",
        conditions: '要求 f(x) 在该区间内可导',
        misconceptions: [
          "把 f'(x) > 0 误读为函数值大于 0",
          '忽略区间前提，直接对整个定义域下结论',
        ],
        citations: [],
      },
    ],
    prerequisites: [
      {
        conceptId: 'kp-derivative',
        conceptName: '导数',
        status: dependencySupplied ? 'SUPPLEMENTED' : 'MISSING',
        reason: "判断单调性依赖 f'(x) 的符号含义，而符号含义建立在导数定义之上。",
        evidence: [],
      },
    ],
  });
}

const MOCK_SUPPLEMENT = `导数是描述函数在一点处变化快慢的量。

设函数 f(x) 在点 x₀ 附近有定义。若下列极限存在，就称 f 在 x₀ 处可导，该极限值记作 f'(x₀)：

　f'(x₀) = lim(Δx → 0) [f(x₀ + Δx) − f(x₀)] / Δx

它的含义是：当自变量从 x₀ 增加很小的一段 Δx 时，函数值平均变化率 [f(x₀ + Δx) − f(x₀)] / Δx 的极限，也就是瞬时变化率。

以 f(x) = x² 在 x₀ = 1 为例：
[f(1 + Δx) − f(1)] / Δx = [(1 + Δx)² − 1] / Δx = (2Δx + Δx²) / Δx = 2 + Δx，
令 Δx → 0 得 f'(1) = 2。即曲线 y = x² 在 x = 1 处的瞬时变化率为 2。

这正解释了为什么能用 f'(x) 的符号判断单调性：f'(x) 为正表示函数值在增大，为负表示在减小。

（以上为系统补充内容，非你上传的讲义。）`;

function mockGeneratedQuiz(refIds: string[]): string {
  const citation = refIds[0]
    ? [{ sourceType: 'material', refId: refIds[0], excerpt: '' }]
    : [];
  return JSON.stringify({
    items: [
      {
        stem: '（基于你的材料生成）若在区间 I 上恒有 f\'(x) < 0，则 f(x) 在 I 上：',
        options: [
          { id: 'A', text: '单调递减' },
          { id: 'B', text: '单调递增' },
          { id: 'C', text: '先减后增' },
          { id: 'D', text: '无法判断' },
        ],
        answer: 'A',
        explanation: "f'(x) < 0 表示函数值随 x 增大而减小，故在 I 上单调递减。",
        citations: citation,
      },
      {
        stem: '（基于你的材料生成）函数 f(x) = x³ − 3x 在 x = 2 处的导数是：',
        options: [
          { id: 'A', text: '6' },
          { id: 'B', text: '9' },
          { id: 'C', text: '12' },
          { id: 'D', text: '3' },
        ],
        answer: 'B',
        explanation: "f'(x) = 3x² − 3，代入 x = 2 得 3 × 4 − 3 = 9。",
        citations: citation,
      },
    ],
  });
}

function mockTutor(materialIds: string[], zeroMaterial: boolean): string {
  const sourceType = materialIds.length > 0 ? 'material' : 'ai-supplement';
  const citations = materialIds[0]
    ? [{ sourceType: 'material', refId: materialIds[0], excerpt: '' }]
    : [];
  const content = zeroMaterial
    ? '现在没有你的材料，我先按通用知识回答：单调性说的是函数在一个区间上“越来越大”还是“越来越小”。判断方法看导数符号——在区间内 f\'(x) > 0 就递增，f\'(x) < 0 就递减。上传你的讲义后，我可以按你老师的定义方式再讲一遍。'
    : "根据你的材料：判断 f(x) 在区间上的单调性，只需看 f'(x) 在该区间上的符号。f'(x) > 0 时递增，f'(x) < 0 时递减，f'(x) = 0 的点是可能的分界点，需要单独判断。";

  return JSON.stringify({
    scope: materialIds.length > 0 ? 'in-material' : 'derivable',
    basedOnMaterial: materialIds.length > 0,
    blocks: [{ content, sourceType, citations }],
    nextStep: {
      kind: 'continue',
      message: '可以继续追问，或者做两道练习检验一下。',
    },
  });
}

/* ==================== OpenAI 兼容适配器 ==================== */

/** 适用于 DeepSeek 等提供 /chat/completions 的接口 */
function createOpenAiCompatibleAdapter(): ModelAdapter {
  return {
    name: env.modelProvider,
    isMock: false,
    call: async (prompt, options = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? env.modelTimeoutMs,
      );

      try {
        const base = env.modelBaseUrl.replace(/\/+$/, '');
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.modelApiKey}`,
          },
          body: JSON.stringify({
            model: env.modelName,
            messages: [
              ...(options.system ? [{ role: 'system', content: options.system }] : []),
              { role: 'user', content: prompt },
            ],
            ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`模型接口返回 ${response.status}`);
        }

        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('模型返回内容为空');
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createModelAdapter(): ModelAdapter {
  return env.useMock ? createMockAdapter() : createOpenAiCompatibleAdapter();
}
