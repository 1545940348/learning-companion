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

import type { ModelCallOptions, ModelInput } from '@lc/teaching';
import type { ModelContentBlock, SourceType } from '@lc/contracts';
import { createDeepseekAdapter } from './deepseek.js';
import { createWorkbuddyModelClient } from './workbuddy.js';
import { env } from '../config/env.js';
// `I38`：`ModelAdapter` 契约已下沉到叶子模块 `./adapter.js`（原因见该文件头）。此处
// 只为**保持既有导入路径可用**而再导出；本文件与 `deepseek.ts` 之间因此不再有直接边。
import type { ModelAdapter } from './adapter.js';

/** 取输入中的文本部分。mock 不做图像识别，含图片时只使用其中的文本块。 */
function toPromptText(input: ModelInput): string {
  if (typeof input === 'string') return input;
  const parts: string[] = [];
  for (const block of input) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n\n');
}

export type { ModelAdapter };

/* ==================== mock 适配器 ==================== */

/**
 * mock 用于无密钥联调。它按提示词中的模块标识返回结构化假数据，
 * 并复用演示案例：单调性材料缺少导数解释 → MISSING，
 * 一旦出现系统补充块则转为 SUPPLEMENTED，便于前端验证完整闭环。
 *
 * **导出是为了可测**（卡 0-4 / `I1`）：`createModelAdapter()` 读环境变量才决定用哪个通道，
 * 回归脚本里没法保证 `MODEL_PROVIDER=mock`；而"mock 通道到底产不产出关系边"
 * 必须能被断言 —— 否则演示与录屏走 mock 时，那条"有边"的界面路径**既不能证实也不能证伪**。
 */
export function createMockAdapter(): ModelAdapter {
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

  if (system.includes('备课模块')) {
    return mockKnowledge(materialIds, supplementIds.length > 0);
  }
  if (system.includes('补充模块')) {
    return mockSupplement();
  }
  if (system.includes('出题模块')) {
    return mockGeneratedQuiz(materialIds);
  }
  return mockTutor(materialIds, supplementIds);
}

function mockKnowledge(materialIds: string[], dependencySupplied: boolean): string {
  /*
   * `I34`：知识点要如实带上**材料引用**。
   *
   * 知识点的 `citations` 是"这条知识点能不能定位到学生材料原文"的唯一依据
   * （`LOCAL` 的契约定义就是"能定位来源"）。原先恒为空数组 →
   * 图谱里哪怕材料确实覆盖了该知识点，也只能落到「未判定」。
   * mock 已能从提示词解析出材料 id（`parseRefIds`），这里如实引用即可。
   */
  const citations = materialIds.map((id) => ({ sourceType: 'material', refId: id, excerpt: '' }));
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
        citations,
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
    /*
     * `I1`（卡 0-4）：**mock 也要产出显式关系边**。
     *
     * 原先 `mockKnowledge` 只返回 `{points, prerequisites}`，`edges` 零命中 →
     * 真实通道将来有边、**mock 通道永远无边** → "有边时界面不再显示『没有关系边』"
     * 这条路径在无密钥的演示/录屏下**既不能证实也不能证伪**（与 `I31`/`I34` 同一条教训：
     * mock 不保真 → 路径走不通 → 修了也看不到效果）。
     *
     * 形状注意：`buildGraph()` 读的是 **`parsed.graph.edges`**（不是顶层 `edges`），
     * 见 `packages/teaching/src/tasks.ts` 的 `buildGraph(parsed.graph, points)`。
     *
     * 方向注意：契约里 `from` = **依赖方**，`to` = **被依赖方**（`contracts/src/knowledge.ts`）。
     * 所以"单调性依赖导数"写成 `kp-monotonicity → kp-derivative`，
     * 与 `verify:graph` 里 `{from:'monotonicity', to:'derivative'}` 的写法一致。
     *
     * ⚠️ `kp-derivative` **故意不在 `points` 里**：它是材料未覆盖的前置缺口（`MISSING`），
     * 不是从材料抽出的知识点。因此这条边的 `to` 指向一个**尚未成为节点**的概念 ——
     * 这是真实存在的数据形态，界面必须如实说明（见 `GraphPanel` 的"未画出连线"提示），
     * 而不是静默丢边或凭空补一个节点。
     */
    graph: {
      edges: [
        {
          from: 'kp-monotonicity',
          to: 'kp-derivative',
          kind: 'prerequisite',
          status: dependencySupplied ? 'SUPPLEMENTED' : 'MISSING',
          reason: "判断单调性依赖 f'(x) 的符号含义，而符号含义建立在导数定义之上。",
        },
      ],
    },
  });
}

/**
 * mock 的缺口补充内容（演示数据）。
 *
 * ### 为什么它现在是 `{content, claims}` 的 JSON（`B3`）
 *
 * 补充模块的提示词已改为**结构化断言**：模型不再"自己宣称数学结论是对的"，
 * 而是把结论写成 `claims` 交给符号引擎核验（`packages/teaching/src/symbolic.ts`）。
 * mock 必须跟着改，否则：
 * - 无密钥的演示/录屏永远拿不到 `claims` → 验证状态永远是 `unverified`，
 *   `P-B2` 要求的 `MISSING → SUPPLEMENTED → VERIFIED` **走不通也证明不了**；
 * - 而 mock 正是演示与全部回归走的那条路（与 `I31`/`I34` 同一条教训：mock 不保真）。
 *
 * `claims` 里的两条与说明书 §7.1 的固定案例**逐字一致**：
 * ① 导数：x² 在 1 处导数为 2（正文里就是这么推的）；② 切线：x² 在 (1,1) 处切线为 y = 2x − 1。
 *
 * ⚠️ **这是演示数据**：正文里"（以上为系统补充内容，非你上传的讲义。）"这句
 * **不得为了让画面干净而删掉**（分镜与 §2.3 都要求显著标注为 AI 补充）。
 */
const MOCK_SUPPLEMENT_CONTENT = `导数是描述函数在一点处变化快慢的量。

设函数 f(x) 在点 x₀ 附近有定义。若下列极限存在，就称 f 在 x₀ 处可导，该极限值记作 f'(x₀)：

　f'(x₀) = lim(Δx → 0) [f(x₀ + Δx) − f(x₀)] / Δx

它的含义是：当自变量从 x₀ 增加很小的一段 Δx 时，函数值平均变化率 [f(x₀ + Δx) − f(x₀)] / Δx 的极限，也就是瞬时变化率。

以 f(x) = x² 在 x₀ = 1 为例：
[f(1 + Δx) − f(1)] / Δx = [(1 + Δx)² − 1] / Δx = (2Δx + Δx²) / Δx = 2 + Δx，
令 Δx → 0 得 f'(1) = 2。即曲线 y = x² 在 x = 1 处的瞬时变化率为 2；
这条切线过点 (1, 1) 且斜率为 2，方程为 y = 2x − 1。

这正解释了为什么能用 f'(x) 的符号判断单调性：f'(x) 为正表示函数值在增大，为负表示在减小。

（以上为系统补充内容，非你上传的讲义。）`;

/** 与 §7.1 固定案例一致的断言（`expr` 用普通表达式即可，白名单也接受 LaTeX） */
const MOCK_SUPPLEMENT_CLAIMS = [
  { kind: 'derivative', expr: 'x^2', at: 1, claimed: 2 },
  { kind: 'tangent', expr: 'x^2', at: 1, claimed: '2x - 1' },
];

function mockSupplement(): string {
  return JSON.stringify({ content: MOCK_SUPPLEMENT_CONTENT, claims: MOCK_SUPPLEMENT_CLAIMS });
}

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

/**
 * mock 的答疑回答。
 *
 * ### 为什么要接收 `supplementIds`（`I31`）
 *
 * 原先只接收 `materialIds`：只要有「已授权的补充块」而**没有学生材料**，
 * 这个函数就恒返回一个**不带任何引用**的 `ai-supplement` 块。而服务端的来源守卫
 * （`validateAnswerBlocks`，材料路径下 `requireAuthorization = true`）对
 * `ai-supplement` 块的要求是「必须引用一个**已授权**的来源」，无引用即被拒 →
 * `/api/tutor` 返回 403 `UNAUTHORIZED_CONTENT`（`I29` 复现的正是这条死路）。
 *
 * 真实模型通常会引用学生已授权的补充块，所以这是 **mock 保真度缺口**，
 * 不是守卫过严：守卫的语义是「回答必须能追溯到真实存在的来源」，无引用即拒。
 * 修法是让 mock 也如实引用 —— 而不是放宽守卫。
 */
function mockTutor(
  materialIds: string[],
  supplementIds: string[],
): string {
  // 学生材料优先；没有材料时退而引用已授权的补充块（这正是「补缺口后能继续问」的路径）
  const hasMaterial = materialIds.length > 0;
  const refId = materialIds[0] ?? supplementIds[0];
  const sourceType: SourceType = hasMaterial ? 'material' : 'ai-supplement';
  const citations = refId ? [{ sourceType, refId, excerpt: '' }] : [];
  const hasSupplement = !hasMaterial && supplementIds.length > 0;

  const content = hasMaterial
    ? "根据你的材料：判断 f(x) 在区间上的单调性，只需看 f'(x) 在该区间上的符号。f'(x) > 0 时递增，f'(x) < 0 时递减，f'(x) = 0 的点是可能的分界点，需要单独判断。"
    : hasSupplement
      ? "根据你已授权的补充内容（不是你的讲义原文，已标注来源）：判断 f(x) 在区间上的单调性，只需看 f'(x) 在该区间上的符号——f'(x) > 0 递增，f'(x) < 0 递减。补充内容里对「为什么 f'(x) > 0 就递增」给了推导，可以直接对着看。"
      : '现在没有你的材料，我先按通用知识回答：单调性说的是函数在一个区间上“越来越大”还是“越来越小”。判断方法看导数符号——在区间内 f\'(x) > 0 就递增，f\'(x) < 0 就递减。上传你的讲义后，我可以按你老师的定义方式再讲一遍。';

  return JSON.stringify({
    scope: hasMaterial ? 'in-material' : 'derivable',
    // 补充块由 AI 生成，不是学生材料 —— 引用了它也不等于「基于材料作答」（说明书 2.1）
    basedOnMaterial: hasMaterial,
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
