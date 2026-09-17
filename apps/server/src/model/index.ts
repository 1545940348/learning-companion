/**
 * 模型适配器 —— C 负责实现与验证（说明书 5.1、C2）
 *
 * 对外只暴露 ModelCaller，教学模块不关心底层是哪家模型。
 *
 * 目录分工：
 * - ./deepseek.ts  默认通道：DeepSeek API（说明书 V1.4）
 * - ./workbuddy.ts SDK 调用细节：超时、密钥脱敏、错误分类
 * - ./budget.ts    单次业务请求的模型调用预算与受控重试（说明书 V1.4）
 * - ./mock.ts      （仍在下方本文件内）无密钥联调用的假数据
 * - ./codebuddy.ts （仍在下方本文件内）历史接入：CodeBuddy Agent SDK，须显式设
 *                  `MODEL_PROVIDER=sdk` 才启用，**不参与自动降级**
 * - ./smoke.ts     冒烟脚本
 */

import type { ModelCaller, ModelCallOptions, ModelInput } from '@lc/teaching';
import type { ModelContentBlock } from '@lc/contracts';
import { createDeepseekAdapter } from './deepseek.js';
import { createWorkbuddyModelClient } from './workbuddy.js';
import { env } from '../config/env.js';

/** 取输入中的文本部分。mock 不做图像识别，含图片时只使用其中的文本块。 */
function toPromptText(input: ModelInput): string {
  if (typeof input === 'string') return input;
  const parts: string[] = [];
  for (const block of input) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n\n');
}

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
    call: async (input, options) => mockRespond(toPromptText(input), options),
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

/* ==================== 真实适配器：CodeBuddy Agent SDK ==================== */

/**
 * 为什么不用 HTTP 直连
 *
 * 本项目的模型接入已确定为 CodeBuddy Agent SDK，认证由 SDK 读取环境变量完成，
 * **没有 base URL，也没有固定模型名** —— 模型由上游动态分配
 * （同日实测 hy3 / glm-5.3 / minimax-m3 三个不同结果，只能从响应回读）。
 * 因此原先 `fetch(\`${MODEL_BASE_URL}/chat/completions\`)` 的写法在本接入方式下无法配置，
 * 已替换为 SDK 调用。详见 docs/tech/2026-09-16-模型接入-CodeBuddy Agent SDK.md。
 */

const JSON_INSTRUCTION =
  '只输出一个 JSON 对象。不要使用 markdown 代码块包裹，不要输出任何解释文字。';

/** 把教学模块的输入统一成 SDK 需要的内容块 */
function normalizeBlocks(input: ModelInput): ModelContentBlock[] {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }
  return input.map((block): ModelContentBlock =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', mediaType: block.mediaType, dataBase64: block.dataBase64 },
  );
}

/**
 * options.json 只能在提示词层面表达。
 *
 * 上游不兑现结构化输出约束（2026-09-16 两次实测），因此这里没有 response_format，
 * 调用方仍需自行解析 JSON 并校验，失败可重试。
 */
function buildSystemPrompt(options: ModelCallOptions): string | undefined {
  const parts: string[] = [];
  if (options.system) parts.push(options.system);
  if (options.json) parts.push(JSON_INSTRUCTION);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function createCodebuddySdkAdapter(): ModelAdapter {
  const client = createWorkbuddyModelClient({
    apiKey: env.codebuddyApiKey,
    environment: env.codebuddyEnvironment,
    timeoutMs: env.modelTimeoutMs,
    log: (line) => console.log(line),
  });

  return {
    name: 'codebuddy-agent-sdk',
    isMock: false,
    call: async (input, options = {}) => {
      const result = await client.complete({
        systemPrompt: buildSystemPrompt(options),
        content: normalizeBlocks(input),
        timeoutMs: options.timeoutMs,
        purpose: 'teaching',
      });
      return result.text;
    },
  };
}

/**
 * 按 env.channel 选择适配器。
 *
 * - `deepseek`（**默认**，说明书 V1.4）：HTTP 适配器，见 ./deepseek.ts
 * - `sdk`（历史接入，须显式启用）：CodeBuddy Agent SDK，见下方 createCodebuddySdkAdapter
 * - `mock`（仅供本地开发，须显式启用）
 *
 * **三档之间没有任何自动降级，也没有 `auto` 档。**
 * 缺密钥或模型失败时由 config/env.ts 明确报错、由适配器抛出 ModelError，
 * 不静默切到其他通道（说明书 V1.4）。
 */
export function createModelAdapter(): ModelAdapter {
  switch (env.channel) {
    case 'sdk':
      return createCodebuddySdkAdapter();
    case 'mock':
      return createMockAdapter();
    default:
      return createDeepseekAdapter();
  }
}
