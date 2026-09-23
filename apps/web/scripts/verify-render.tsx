/**
 * 界面渲染冒烟（替代浏览器验证，对应待办 P-A15）
 *
 * ### 为什么需要它
 *
 * 本环境**无法做浏览器视觉验证**（不能 `npm install -g`，因此没有 `agent-browser`）。
 * 于是在"界面到底渲染得出来吗"和"未实现的能力是不是真的标注了"这两件事上，
 * 此前只能靠人看。这个脚本用 `react-dom/server` 把各面板渲染成 HTML 字符串，
 * 断言关键文案与标注**确实出现在输出里**。
 *
 * 它**不能**替代视觉验证：布局、配色、交互、响应式都测不到。
 * 它能覆盖的是：模块能否加载、渲染期是否抛异常、以及
 * **§4.2/§4.3/§9 要求的那些"如实标注"是否真的渲染出来了**。
 *
 * ### 用法
 *
 *   npm run verify:render -w @lc/web
 */

/* tsx 对该文件不套用 tsconfig 的 jsx: react-jsx（scripts/ 不在 include 内），
   因此需要显式引入 React 以兼容经典 JSX 运行时 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GraphNeighborhood, HealthResponse, LearnerProfile } from '@lc/contracts';
import type {
  GapRecord,
  TutorTurn,
  AccountInfo,
  ClassAggregate,
  SessionHistoryEntry,
  UiMaterial,
  WorkbenchActions,
  WorkbenchState,
} from '../src/app/model/workbench-types';
import { CLIENT_TIMEOUT_MS, describeAbort } from '../src/api';
import { shouldOfferRetry } from '../src/app/model/notice';
import {
  parseEntries,
  removeEntry,
  trimTurns,
  upsertEntry,
} from '../src/app/model/session-history';
import { ErrorBoundary } from '../src/app/providers/ErrorBoundary';
import { GraphPanel } from '../src/components/GraphPanel';
import { KnowledgePanel } from '../src/components/KnowledgePanel';
import { MaterialPanel } from '../src/components/MaterialPanel';
import { ProfilePanel } from '../src/components/ProfilePanel';
import { QuizPanel } from '../src/components/QuizPanel';
import { ConversationView } from '../src/components/ConversationView';
import { AppShell } from '../src/components/AppShell';
import { SidebarNav } from '../src/components/SidebarNav';
import { TeacherPanel } from '../src/components/TeacherPanel';
import { AccountView } from '../src/components/AccountView';
import {
  deriveSessionLabel,
  describePending,
  describeSession,
  formatClock,
  formatRelativeDay,
  summarizeQuestion,
  toChatMessages,
} from '../src/app/model/conversation';
import { VoiceInputButton } from '../src/components/VoiceInputButton';
import type { SpeechRecognitionCtorLike } from '../src/shared/lib/voice-support';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail !== undefined ? ` —— ${JSON.stringify(detail)}` : ''}`);
  }
}

/** 渲染并断言不抛异常；返回 HTML 便于继续断言文案 */
function render(label: string, node: ReactElement): string {
  try {
    const html = renderToStaticMarkup(node);
    check(`${label} 渲染未抛异常`, true);
    return html;
  } catch (error) {
    check(`${label} 渲染未抛异常`, false, (error as Error)?.message);
    return '';
  }
}

/** 取出图谱节点下方那行状态文案（用于断言节点状态是否如实） */
function nodeLabels(markup: string): string[] {
  return [...markup.matchAll(/graph-node-sub"[^>]*>([^<]*)</g)].map((match) => match[1] ?? '');
}

const noop = async () => {};
const asyncTrue = async () => true;
const asyncEmptyItems = async () => [];

/**
 * 假的识别构造器：只为让能力探测通过。
 * 它**不会被真正实例化** —— 组件在渲染期只做探测，起停要点了按钮才发生；
 * 而识别的逻辑分支由 `scripts/verify-voice.ts` 用假对象覆盖。
 */
function FakeRecognition(): void {
  /* 空构造器 */
}

function makeWb(overrides: Partial<WorkbenchState & WorkbenchActions> = {}): WorkbenchState & WorkbenchActions {
  return {
    sessionId: 's-1',
    materialVersion: 1,
    materials: [],
    knowledge: null,
    graph: null,
    gaps: {},
    history: [],
    profile: null,
    notice: null,
    busy: null,
    anyBusy: false,
    canRetry: false,
    parseUnavailable: [],
    focusedNodeId: null,
    historyEntries: [],
    submitMaterials: asyncTrue,
    correctMaterial: noop,
    supplementGap: noop,
    claimKnown: noop,
    ask: asyncTrue,
    loadQuiz: asyncEmptyItems,
    reportQuizAttempt: noop,
    refreshGraph: noop,
    fetchProfile: noop,
    startNewStudy: noop,
    switchSession: noop,
    dismissNotice: () => {},
    notify: () => {},
    ensureMaterialSession: async () => 's-1',
    isBusy: () => false,
    retryLastFailed: noop,
    focusNode: () => {},
    cancelPending: () => 0,
    ...overrides,
  };
}

const material: UiMaterial = {
  id: 'm-1',
  kind: 'upload',
  text: '判断 f(x) 的单调性：只需看 f′(x) 的符号。',
  createdAt: new Date().toISOString(),
};

console.log('=== 界面渲染冒烟 ===\n');

/* ==================== 1. 材料面板 ==================== */

console.log('--- 1. 材料面板：三个入口齐全 + 未接入如实标注 ---');
{
  const html = render('材料面板（空）', <MaterialPanel wb={makeWb()} mock={false} />);
  check('文字入口存在', html.includes('单次'));
  check('★ 图片入口存在', html.includes('上传图片'));
  check('★ 语音入口存在（A1 要求三入口齐全）', html.includes('语音输入'));
  /*
   * 降级路径：本脚本跑在 node 里，`detectVoiceSupport()` 必然判定"不支持"
   * （那里没有 `SpeechRecognition`），**正好用来锁"不支持时怎么显示"**：
   * 必须给出原因，而不是给一个灰按钮了事。
   */
  check('★ 不支持时说明原因，不是只给一个灰按钮', html.includes('这个浏览器不支持语音输入'), null);
  const voiceButton = (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find((tag) =>
    tag.includes('语音输入'),
  );
  check(
    '★ 不支持时语音按钮被禁用（按按钮文案定位，不是页面级宽匹配）',
    Boolean(voiceButton) && /disabled/.test(voiceButton ?? ''),
    voiceButton ?? null,
  );
}

{
  /*
   * 支持时（`D3` 口径）：必须写明**识别发生在浏览器**、**服务端不做语音转写**，且按钮可用。
   * node 里没有真的识别对象，故注入一个假的构造器 —— `VoiceInputButton` 的 `env`
   * 参数就是为这条断言留的口子。少了这一段，"支持时界面长什么样"没有任何覆盖。
   */
  const supported = render(
    '语音按钮（浏览器支持）',
    <VoiceInputButton
      onTranscript={() => {}}
      env={{
        speechRecognition: FakeRecognition as unknown as SpeechRecognitionCtorLike,
        isSecureContext: true,
      }}
    />,
  );
  check('★ 支持时写明「识别在你的浏览器里完成」', supported.includes('识别在你的浏览器里完成'), null);
  check('★ 支持时写明「服务端不做语音转写」', supported.includes('服务端不做语音转写'), null);
  check(
    '★ 支持时按钮可用（既不给 disabled，也不显示"不支持"的理由）',
    !/<button[^>]*\sdisabled/.test(supported) && !supported.includes('这个浏览器不支持语音输入'),
    supported.slice(0, 160),
  );
}

{
  /*
   * 非安全上下文（http 页面）：浏览器禁用麦克风。
   * 这条必须与"浏览器不支持"**分开说** —— 学生换个浏览器解决不了它，得换 https，
   * 两句提示混成一句就等于没给出可操作的信息。
   */
  const insecure = render(
    '语音按钮（非 https）',
    <VoiceInputButton
      onTranscript={() => {}}
      env={{
        speechRecognition: FakeRecognition as unknown as SpeechRecognitionCtorLike,
        isSecureContext: false,
      }}
    />,
  );
  check('★ 非 https 时给出的原因与"浏览器不支持"不同', insecure.includes('不是安全连接'), null);
  check('★ 非 https 时不误报成"浏览器不支持"', !insecure.includes('这个浏览器不支持语音输入'), null);
}

{
  const html = render('材料面板（mock）', <MaterialPanel wb={makeWb({ materials: [material] })} mock />);
  check('★ mock 通道有可见提示，不冒充真实输出', html.includes('演示通道'), null);
  check('mock 提示含"不代表真实模型"', html.includes('不代表真实模型'));
}

{
  /*
   * 未接入的识别通道必须如实列出（§9）。
   *
   * ⚠️ 这里**只用 `audio`**：`formula` 不是"未接入的通道"（图片路径早已接、纯文字路径
   * 压根没有"识别公式"这一环），2026-09-22 起服务端也不再产出它。
   * 原先这条用例写的是 `parseUnavailable: ['formula']` + 断言渲染出「公式识别（LaTeX）」
   * —— **等于把误报锁进了渲染测试**，所以它一直没被报出来。
   */
  const html = render(
    '材料面板（有未接入通道）',
    <MaterialPanel wb={makeWb({ materials: [material], parseUnavailable: ['audio'] })} mock={false} />,
  );
  check('★ 如实列出未接入的识别环节', html.includes('语音转写'), null);
  check('说明材料按纯文本参与解析', html.includes('纯文本'));
  check(
    '★ 公式不再被当成"未接入的环节"（能力 ≠ 结果）',
    !html.includes('公式识别（LaTeX）'),
    null,
  );
}

{
  /*
   * 图片材料识别到的公式（LaTeX **源码**）要看得见；"没找到"与"没接入"要分开说。
   * 这两条是 2026-09-22 那次修正的**界面落点**，必须锁住 —— 否则改回误报也没人拦。
   */
  const withFormulas: UiMaterial = {
    ...material,
    id: 'm-formula',
    text: "设 f(x)=x^{3}-3x，求 f'(x) 与单调区间。",
    formulas: ['f(x)=x^{3}-3x', "f'(x)=3x^{2}-3"],
  };
  const shown = render(
    '材料面板（图片里有公式）',
    <MaterialPanel wb={makeWb({ materials: [withFormulas] })} mock={false} />,
  );
  check(
    '★ 图片识别到的公式按 LaTeX 源码展示出来（不再被丢掉）',
    shown.includes('f(x)=x^{3}-3x') && shown.includes('material-formulas'),
    null,
  );
  check(
    '公式区写明"本版不做排版"（不把源码冒充排版好的公式）',
    shown.includes('本版不做排版'),
  );

  const noFormula: UiMaterial = { ...material, id: 'm-noformula', formulas: [] };
  const empty = render(
    '材料面板（图里确实没有公式）',
    <MaterialPanel wb={makeWb({ materials: [noFormula] })} mock={false} />,
  );
  check('★ 图里没公式时中性说明"本次没有"', empty.includes('这张图里没有识别到公式'));
  check('★ 并明确它不是"通道没接"', empty.includes('不是「公式通道没接」'));

  const plain = render(
    '材料面板（手打材料）',
    <MaterialPanel wb={makeWb({ materials: [material] })} mock={false} />,
  );
  check(
    '★ 手打材料对公式一个字都不说（`undefined` 与空数组是两回事）',
    !plain.includes('没有识别到公式'),
  );
}

{
  // 识别存疑片段要标出来（§2.2）
  const shaky: UiMaterial = {
    ...material,
    id: 'm-2',
    text: '前一句正常。f′(x) 这一段可能识别错。后面正常。',
    lowConfidence: [{ start: 6, end: 16, reason: '公式识别不确定' }],
  };
  const html = render('材料面板（有识别存疑）', <MaterialPanel wb={makeWb({ materials: [shaky] })} mock={false} />);
  check('★ 存疑片段被标为「识别可能不准」', html.includes('识别可能不准') || html.includes('有识别存疑处'));
  check('★ 存疑片段用 mark 标出', html.includes('low-conf'));
}

/* ==================== 2. 知识点与缺口 ==================== */

console.log('\n--- 2. 知识点面板：六态与缺口入口 ---');
{
  const html = render('知识点面板（未解析）', <KnowledgePanel wb={makeWb()} />);
  check('未解析时给出引导文案', html.includes('还没有解析材料'));
}

{
  const wb = makeWb({
    knowledge: {
      points: [
        {
          id: 'kp-monotonicity',
          name: '单调性',
          explanation: 'f′(x) > 0 时递增。',
          citations: [],
          verification: 'unverified',
        },
      ],
      prerequisites: [
        {
          conceptId: 'kp-derivative',
          conceptName: '导数',
          status: 'MISSING',
          reason: '判断单调性依赖导数的符号含义。',
          evidence: [],
          verification: 'unverified',
        },
      ],
    },
  });
  const html = render('知识点面板（有缺口）', <KnowledgePanel wb={wb} />);
  check('★ MISSING 显示为「材料未覆盖」', html.includes('材料未覆盖'));
  check('★ 给出「补上这一段」入口', html.includes('补上这一段'));
  check('给出「我已掌握，继续」', html.includes('我已掌握，继续'));
  check('未授权时说明不会自动生成', html.includes('不点就不会生成'));
  check('★ 知识点标「未验证」', html.includes('未验证'));
}

{
  // 补充后：AI 补充内容必须显著标注且不降权
  const gap: GapRecord = {
    content: '导数描述函数在某点的瞬时变化率……',
    supplementBlockId: 'sup-1',
    status: 'SUPPLEMENTED',
    verification: 'unverified',
  };
  const wb = makeWb({
    knowledge: {
      points: [],
      prerequisites: [
        {
          conceptId: 'kp-derivative',
          conceptName: '导数',
          status: 'MISSING',
          reason: '需要',
          evidence: [],
          verification: 'unverified',
        },
      ],
    },
    gaps: { 'kp-derivative': gap },
  });
  const html = render('知识点面板（已补充）', <KnowledgePanel wb={wb} />);
  check('★ AI 补充内容有显著横幅标注', html.includes('AI 补充：非上传讲义内容'), null);
  check('★ 状态显示为「AI 已补充」', html.includes('AI 已补充'));
  check('补充内容不被收进依据详情（正文可见）', html.includes('瞬时变化率'));
}

/* ==================== 3. 答疑 ==================== */

console.log('\n--- 3. 答疑面板：mock 标记与验证状态 ---');
{
  const turn: TutorTurn = {
    id: 't-1',
    question: '为什么 f′(x) > 0 递增？',
    mode: 'hint',
    answer: {
      scope: 'in-material',
      basedOnMaterial: true,
      blocks: [
        {
          content: '看导数符号即可。',
          sourceType: 'material',
          citations: [],
          verification: 'unverified',
        },
      ],
    },
    stale: false,
    at: new Date().toISOString(),
  };

  const plain = render('答疑面板（真实通道）', <ConversationView wb={makeWb({ history: [turn] })} mock={false} />);
  check('回答块标出验证状态', plain.includes('未验证'));
  check('★ 真实通道不出现 mock 标记', !plain.includes('mock 演示数据'));
  check('标明是否基于材料', plain.includes('基于你的材料'));

  const mocked = render('答疑面板（mock 通道）', <ConversationView wb={makeWb({ history: [turn] })} mock />);
  check('★ mock 通道下每条回答带「mock 演示数据」标记', mocked.includes('mock 演示数据'), null);

  // I14：被来源校验拦下的块必须如实告知，不得无声消失
  const dropped: TutorTurn = {
    ...turn,
    answer: {
      ...turn.answer,
      blocks: [turn.answer.blocks[0]],
      droppedBlocks: { count: 1, reasons: ['AI 补充内容未经学生授权'] },
    },
  };
  const withDrop = render(
    '答疑面板（有块被校验丢弃，I14）',
    <ConversationView wb={makeWb({ history: [dropped] })} mock={false} />,
  );
  check('★ 被拒块的丢弃事实被显示出来', withDrop.includes('本次回答不完整'), null);
  check(
    '★ 说明丢了几段、以及被拦的原因',
    withDrop.includes('另有 1 段内容没有展示') && withDrop.includes('AI 补充内容未经学生授权'),
    null,
  );
  check('★ 没有丢弃时不出现该提示（不制造虚假警报）', !plain.includes('本次回答不完整'));
}

/* ==================== 4. 图谱 ==================== */

console.log('\n--- 4. 图谱面板：没有关系边时不凭空连线 ---');
{
  const graph: GraphNeighborhood = {
    sessionId: 's-1',
    materialVersion: 1,
    rootConceptId: null,
    nodes: [
      { id: 'kp-mono', name: '单调性', explanation: '', citations: [], verification: 'unverified' },
    ],
    edges: [],
  };
  const html = render('图谱面板（只有节点）', <GraphPanel wb={makeWb({ graph })} />);
  check('★ 明确说明只有节点、没有关系边', html.includes('没有关系边'), null);
  check('说明界面不会凭空连线', html.includes('不会凭空连线'));
  check('渲染出节点', html.includes('单调性'));
  // I20①：没有覆盖判定记录的节点**不得**默认显示「材料已覆盖」
  check(
    '★ 无判定记录的节点标「未判定」，不冒充「材料已覆盖」（I20①）',
    nodeLabels(html).length > 0 && nodeLabels(html).every((label) => label === '未判定'),
    nodeLabels(html),
  );
  check('★ 说明「没有做过判定就不算材料已覆盖」', html.includes('没有做过判定就不算'));
}

/* ==================== 4b. 卡片 ↔ 图谱联动（P-A8） ==================== */

console.log('\n--- 4b. 卡片与图谱联动：高亮与定位 ---');
{
  const graph: GraphNeighborhood = {
    sessionId: 's-1',
    materialVersion: 1,
    rootConceptId: null,
    nodes: [
      { id: 'kp-mono', name: '单调性', explanation: '看 f′(x) 符号。', citations: [], verification: 'unverified' },
      { id: 'kp-derivative', name: '导数', explanation: '', citations: [], verification: 'unverified' },
    ],
    edges: [],
  };
  const knowledge = {
    points: [
      {
        id: 'kp-mono',
        name: '单调性',
        explanation: 'f′(x) > 0 时递增。',
        citations: [],
        verification: 'unverified' as const,
      },
    ],
    prerequisites: [],
  };

  const idle = render('知识点面板（未选中）', <KnowledgePanel wb={makeWb({ knowledge })} />);
  check('未选中时给出「在图谱中查看」入口', idle.includes('在图谱中查看'));
  check('★ 未选中时不带高亮样式', !idle.includes('kp-card-focus'));

  const focused = render(
    '知识点面板（已选中）',
    <KnowledgePanel wb={makeWb({ knowledge, focusedNodeId: 'kp-mono' })} />,
  );
  check('★ 选中的卡片带高亮样式', focused.includes('kp-card-focus'));
  check('★ 选中后入口变为「取消图谱高亮」', focused.includes('取消图谱高亮'));
  check('说明只是定位、不改变状态', focused.includes('不改变任何状态'));

  const graphIdle = render('图谱面板（未选中）', <GraphPanel wb={makeWb({ graph })} />);
  check('★ 未选中时不给节点加高亮类', !graphIdle.includes('graph-rect-focus'));
  check('给出联动引导文案', graphIdle.includes('互相定位与高亮'));

  const graphFocused = render('图谱面板（已选中）', <GraphPanel wb={makeWb({ graph, focusedNodeId: 'kp-mono' })} />);
  check('★ 选中的节点带高亮类', graphFocused.includes('graph-rect-focus'));
  check('★ 选中后给出「取消选中」出口', graphFocused.includes('取消选中'));
  check('选中态下仍不凭空连线（无边时不渲染 edge）', !graphFocused.includes('graph-edge'));

  // 选中项不在图谱里：必须如实说明，不能假装定位成功
  const missing = render(
    '图谱面板（选中项不在图谱中）',
    <GraphPanel wb={makeWb({ graph, focusedNodeId: 'kp-not-in-graph' })} />,
  );
  check('★ 选中项不在图谱中时如实说明', missing.includes('不在当前图谱的节点里'), null);
}

/* ==================== 4c. 图谱（有关系边时，P-A4） ==================== */

console.log('\n--- 4c. 图谱有边时的渲染：等 I1 交付后即可用这批断言验收 ---');
{
  // 边的产出属 B（I1）。这里用**合成的边**把渲染路径先锁住：
  // 这样 B 一旦把 edges 接上，前端是不是对的可以立刻判定，不必等浏览器人工看。
  const nodes = [
    { id: 'kp-mono', name: '单调性', explanation: '', citations: [], verification: 'unverified' as const },
    { id: 'kp-derivative', name: '导数', explanation: '', citations: [], verification: 'unverified' as const },
    { id: 'kp-slope', name: '斜率', explanation: '', citations: [], verification: 'unverified' as const },
  ];

  const withEdges: GraphNeighborhood = {
    sessionId: 's-1',
    materialVersion: 1,
    rootConceptId: null,
    nodes,
    edges: [
      {
        from: 'kp-mono',
        to: 'kp-derivative',
        kind: 'prerequisite',
        status: 'LOCAL',
        reason: '判断单调性需要导数的符号含义',
        evidence: [],
        verification: 'unverified',
      },
      {
        from: 'kp-derivative',
        to: 'kp-slope',
        kind: 'prerequisite',
        status: 'MISSING',
        reason: '导数概念依赖斜率',
        evidence: [],
        inferred: true,
        verification: 'unverified',
      },
    ],
  };

  const html = render('图谱面板（有关系边）', <GraphPanel wb={makeWb({ graph: withEdges })} />);

  check('★ 关系边被渲染出来', html.includes('graph-edge'), null);
  check('★ 关系类型显示为中文（前置）', html.includes('前置'), null);
  check('★ 推断出的边标注「（推断）」', html.includes('（推断）'), null);
  check(
    '★ 有边时不再显示"没有关系边"的警告（两种状态不能同时出现）',
    !html.includes('没有关系边'),
  );
  check('边数出现在面板头部', /2 关系/.test(html));

  // 分层：有边时节点应分布在不同列（x 不同）；无边时应全在同一列。
  const columnsOf = (markup: string) =>
    new Set([...markup.matchAll(/<rect x="(\d+)"/g)].map((m) => m[1]));

  const edgeColumns = columnsOf(html);
  check('★ 有边时节点按依赖深度分层（多列）', edgeColumns.size > 1, [...edgeColumns]);

  const noEdgeHtml = render(
    '图谱面板（同样三个节点但无边）',
    <GraphPanel wb={makeWb({ graph: { ...withEdges, edges: [] } })} />,
  );
  const flatColumns = columnsOf(noEdgeHtml);
  check(
    '★ 无边时节点不假装分层（单列）',
    flatColumns.size === 1,
    [...flatColumns],
  );
  check('无边时如实说明只有节点', noEdgeHtml.includes('没有关系边'));

  /*
   * `I1` 落地后新增的数据形态：**有边，但边的端点不是节点**。
   *
   * 契约里 `to` 是"被依赖的前置概念"，它可以是材料未覆盖、尚未被抽为节点的概念
   * （演示案例里正是导数缺口）。这种边画不出线（SVG 需要两端坐标），
   * 此前被静默丢弃 —— 头部显示"N 关系"却一条线都没有，看的人只会以为界面坏了。
   */
  const danglingGraph: GraphNeighborhood = {
    ...withEdges,
    edges: [
      {
        from: 'kp-mono',
        to: 'kp-not-extracted',
        kind: 'prerequisite',
        status: 'MISSING',
        reason: '前置缺口概念尚未抽取为节点',
        evidence: [],
        verification: 'unverified',
      },
    ],
  };
  const danglingHtml = render(
    '图谱面板（边指向尚未抽取为节点的概念）',
    <GraphPanel wb={makeWb({ graph: danglingGraph })} />,
  );
  check(
    '★ 端点不是节点的边：如实说明"未画出连线"的条数（不静默丢边）',
    danglingHtml.includes('条关系指向尚未抽取为节点的概念'),
    null,
  );
  check(
    '★ 反例：端点都是节点时不出现该说明（防止这条断言恒真）',
    !html.includes('条关系指向尚未抽取为节点的概念'),
  );
}

/* ==================== 4d. 图谱节点状态取自真实判定（I20①） ==================== */

console.log('\n--- 4d. 图谱节点状态：只显示本会话真的做过的判定（I20①） ---');
{
  const graph: GraphNeighborhood = {
    sessionId: 's-1',
    materialVersion: 1,
    rootConceptId: null,
    nodes: [
      { id: 'kp-mono', name: '单调性', explanation: '', citations: [], verification: 'unverified' },
      { id: 'kp-derivative', name: '导数', explanation: '', citations: [], verification: 'unverified' },
      { id: 'kp-slope', name: '斜率', explanation: '', citations: [], verification: 'unverified' },
    ],
    edges: [],
  };
  const knowledge = {
    points: [],
    prerequisites: [
      {
        conceptId: 'kp-mono',
        conceptName: '单调性',
        status: 'LOCAL' as const,
        reason: '材料里有导数的符号说明',
        evidence: [],
        verification: 'unverified' as const,
      },
      {
        conceptId: 'kp-derivative',
        conceptName: '导数',
        status: 'MISSING' as const,
        reason: '材料没有导数定义',
        evidence: [],
        verification: 'unverified' as const,
      },
    ],
  };

  const html = render('图谱面板（有判定记录）', <GraphPanel wb={makeWb({ graph, knowledge })} />);
  const labels = nodeLabels(html);
  check(
    '★ 节点状态取自 /api/knowledge 的覆盖判定（已覆盖 / 未覆盖 / 未判定 各得其所）',
    ['材料已覆盖', '材料未覆盖', '未判定'].every((item) => labels.includes(item)),
    labels,
  );
  check('★ 无判定记录的节点仍标「未判定」', labels.filter((item) => item === '未判定').length === 1, labels);
  check('★ 提示里给出未判定的节点数', html.includes('有 1 个节点本会话没有覆盖判定记录'));

  // 补充记录优先于关系判定：学生刚点过「补上这一段」，状态应立刻跟上
  const gap: GapRecord = {
    content: '导数描述瞬时变化率……',
    supplementBlockId: 'sup-1',
    status: 'SUPPLEMENTED',
    verification: 'unverified',
  };
  const afterGap = render(
    '图谱面板（补过缺口后）',
    <GraphPanel wb={makeWb({ graph, knowledge, gaps: { 'kp-derivative': gap } })} />,
  );
  const afterLabels = nodeLabels(afterGap);
  check('★ 补充记录优先：该节点转为「AI 已补充」', afterLabels.includes('AI 已补充'), afterLabels);
  check(
    '★ 未补的节点不受影响（不整片改变状态）',
    afterLabels.includes('材料已覆盖') && afterLabels.includes('未判定'),
    afterLabels,
  );
}

/* ==================== 4e. 真实生成数据的 id 形态（I34） ==================== */

console.log('\n--- 4e. 节点 id 与前置 conceptId 不重叠时（真实生成数据的形态，I34） ---');
{
  /*
   * ⚠️ 上面 4d 的夹具把**节点 id 与前置 conceptId 手工对齐**了，
   * 而生成器从不产生这种数据（`apps/server/src/model/index.ts` 的 mock 产出：
   * 节点 `kp-monotonicity`、前置 `kp-derivative`）—— 因此 4d **锁不住真实场景**。
   * 这一节用与生成器同形的数据来锁：节点 id 与前置 conceptId 不同名。
   */
  const graph: GraphNeighborhood = {
    sessionId: 's-1',
    materialVersion: 1,
    rootConceptId: null,
    nodes: [
      { id: 'kp-monotonicity', name: '单调性', explanation: '', citations: [], verification: 'unverified' },
    ],
    edges: [],
  };
  const prerequisites = [
    {
      conceptId: 'kp-derivative',
      conceptName: '导数',
      status: 'MISSING' as const,
      reason: '材料没有导数定义',
      evidence: [],
      verification: 'unverified' as const,
    },
  ];

  // 材料确实覆盖了该知识点（points[].id 与节点 id 同名且带材料引用）
  const cited = render(
    '图谱面板（知识点带材料引用，I34）',
    <GraphPanel
      wb={makeWb({
        graph,
        knowledge: {
          points: [
            {
              id: 'kp-monotonicity',
              name: '单调性',
              explanation: '',
              citations: [{ sourceType: 'material' as const, refId: 'm-1', excerpt: '' }],
              verification: 'unverified' as const,
            },
          ],
          prerequisites,
        },
      })}
    />,
  );
  const citedLabels = nodeLabels(cited);
  check(
    '★ 节点 id 与前置 conceptId 不同名时，仍按知识点自身的材料引用判出「材料已覆盖」（I34）',
    citedLabels.includes('材料已覆盖'),
    citedLabels,
  );
  check(
    '★ 不再恒为「未判定」（本会话确实做过覆盖判定）',
    !cited.includes('没有覆盖判定记录'),
    cited.includes('没有覆盖判定记录'),
  );

  // 反例：知识点没有引用 → 仍标「未判定」，不把"模型没给引用"说成"材料未覆盖"
  const uncited = render(
    '图谱面板（知识点无引用，I34）',
    <GraphPanel
      wb={makeWb({
        graph,
        knowledge: {
          points: [
            {
              id: 'kp-monotonicity',
              name: '单调性',
              explanation: '',
              citations: [],
              verification: 'unverified' as const,
            },
          ],
          prerequisites,
        },
      })}
    />,
  );
  const uncitedLabels = nodeLabels(uncited);
  check(
    '★ 知识点无引用时仍标「未判定」（不冒充已覆盖，也不改判为未覆盖）',
    uncitedLabels.includes('未判定') && !uncitedLabels.includes('材料已覆盖'),
    uncitedLabels,
  );
}

/* ==================== 5. 练习 ==================== */

console.log('\n--- 5. 练习面板 ---');
{
  const html = render('练习面板', <QuizPanel wb={makeWb()} />);
  check('提交前不展示答案的说明存在', html.includes('答案在你提交之前不会显示'));
  check('★ 说明自编题解析不算材料证据', html.includes('不算作你材料的证据'));

  // I20⑥：零材料时不许「按我的材料出题」—— 否则会拿到与材料无关却标着
  // 「基于你的材料生成」的题（真实性红线）。此分支只能靠点击进入，
  // 故用 `initialSource` 在 SSR 里直接渲染该状态。
  const blocked = render(
    '练习面板（零材料 · 选了按材料出题，I20⑥）',
    <QuizPanel wb={makeWb({ materials: [] })} initialSource="material" />,
  );
  check('★ 零材料时明确说明不能按材料出题', blocked.includes('不能「按我的材料出题」'), null);
  check(
    '★ 指出替代路径（先提交讲义 / 改用项目自编题）',
    blocked.includes('请先在「材料」面板提交讲义') && blocked.includes('项目自编题'),
  );
  /*
   * 这条断言原先用**页面级宽正则** `/<button class="btn"[^>]*disabled/` ——
   * 页面上**任意一个** `.btn` 被禁用都会让它通过（已登记的弱点）。
   * 现改为按**按钮文案**定位那一个按钮，再断它带 `disabled`：
   * 即使将来别的按钮被禁用，这条也只能靠"出题按钮确实被禁用"通过。
   */
  const blockedButtons = blocked.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const startButton = blockedButtons.find((tag) => tag.includes('开始练习'));
  check(
    '★ 出题按钮被禁用（按按钮文案定位，不是页面级宽匹配）',
    Boolean(startButton) && /disabled/.test(startButton ?? ''),
    startButton ?? null,
  );
}

/* ==================== 6. 画像 ==================== */

console.log('\n--- 6. 画像面板 ---');
{
  const profile: LearnerProfile = {
    sessionId: 's-1',
    mastery: { 'kp-derivative': 'SUPPLEMENTED' },
    gaps: [{ conceptId: 'kp-derivative', resolvedAt: new Date().toISOString() }],
    misconceptions: [],
    updatedAt: new Date().toISOString(),
  };
  const html = render('画像面板（有数据）', <ProfilePanel wb={makeWb({ profile })} />);
  check('展示掌握状态', html.includes('AI 已补充'));
  check('★ 说明「我已掌握」不改变材料覆盖状态', html.includes('不会把材料未覆盖改判为已覆盖'));
  check('★ 说明 AI 已补充不等于已验证', html.includes('不等于已验证'));

  // I20⑦：练习提交**不会**写 mastery（服务端 quiz-attempted 落 default 分支），
  // 因此原文"提交一次练习后就会出现"是撑不住的声明。
  const empty = render(
    '画像面板（本会话无掌握条目，I20⑦）',
    <ProfilePanel
      wb={makeWb({
        profile: { sessionId: 's-1', mastery: {}, gaps: [], misconceptions: [], updatedAt: new Date().toISOString() },
      })}
    />,
  );
  check('★ 如实说明只有「补上这一段」会写入掌握状态', empty.includes('只有「补上这一段」会写入掌握状态'), null);
  check('★ 不再声称「提交一次练习后就会出现」', !empty.includes('提交一次练习后就会出现'));
}

/* ==================== 7. 提示与重试（I20⑤） ==================== */

console.log('\n--- 7. 重试按钮的显示条件（I20⑤） ---');
{
  /*
   * 这条规则原先只能靠"读 App.tsx 确认"，而它恰恰是错的：
   * 只要 `canRetry`（上一次动作失败过）为真，**任何**提示上都会挂「重试」——
   * 包括"已按修正后的内容重建…"这类成功提示，甚至"上一个操作还没完成"
   * 这种根本不是失败的提示。点它会重放一个与当前提示无关的旧动作。
   * 现在把判定提成纯函数 `shouldOfferRetry`，语义可以被断言。
   */
  check(
    '★ 与服务端标为可重试的失败提示一起出现',
    shouldOfferRetry({ kind: 'error', text: '解答失败', retryable: true }, true),
  );
  check(
    '★ 成功提示上不挂重试（即使此前失败过）',
    !shouldOfferRetry({ kind: 'info', text: '已按修正后的内容重建知识点与依赖关系' }, true),
  );
  check(
    '★ 非失败提示（上一个操作未完成）上不挂重试',
    !shouldOfferRetry({ kind: 'warn', text: '上一个操作还没完成' }, true),
  );
  check('★ 没有失败动作时不挂重试', !shouldOfferRetry({ kind: 'error', text: 'x', retryable: true }, false));
  check('★ 没有提示时不挂重试', !shouldOfferRetry(null, true));
}

/* ==================== 8. 阶段 0：兜底与中止（卡 2 / 卡 3） ==================== */

console.log('\n--- 8. ErrorBoundary 与请求中止（阶段 0 卡 2 / 卡 3） ---');
{
  /*
   * ⚠️ **SSR 下错误边界不生效**：`renderToStaticMarkup` 遇到抛错直接抛，
   * 不会走 `getDerivedStateFromError`。因此"渲染一个会抛错的子组件、断言出现兜底文案"
   * 这条写法**在本脚本里永远不成立**（要么假失败、要么被绕过后恒真）。
   * 正确做法：纯逻辑断言 + 正常路径断言。
   */
  const derived = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
  check(
    '★ ErrorBoundary：捕获后转成兜底状态（纯逻辑，SSR 下走不到这里所以直接调）',
    derived.hasError === true && derived.message === 'boom',
    derived,
  );

  const normal = render(
    'ErrorBoundary 包裹下的正常子树',
    <ErrorBoundary label="学习工作台">
      <p>NORMAL-CHILD-MARK</p>
    </ErrorBoundary>,
  );
  check(
    '★ ErrorBoundary：无错时原样渲染子树，且不出现兜底文案',
    normal.includes('NORMAL-CHILD-MARK') && !normal.includes('在渲染时出错了'),
    normal.slice(0, 120),
  );

  /*
   * 卡 3：中止的两种成因必须给出**不同**的说法。
   * 超时是失败（可重试）；取消是学生主动动作（不该被渲染成失败、也不该给重试）。
   */
  const timeout = describeAbort('timeout');
  const cancelled = describeAbort('cancelled');
  check(
    '★ 超时提示可重试，且写明秒数（与服务端 90 s 单次上限区分开）',
    timeout.retryable === true && timeout.text.includes(String(CLIENT_TIMEOUT_MS / 1000)),
    timeout,
  );
  check('★ 取消**不**标记为可重试（取消不是失败）', cancelled.retryable === false, cancelled);
  check(
    '★ 超时与取消的文案不同（混成一句话就无法区分"我的操作失败了"与"我自己按的")',
    timeout.text !== cancelled.text,
    { timeout: timeout.text, cancelled: cancelled.text },
  );
}

/* ==================== 9. 外壳与对话模型（L 档改造，2026-09-23） ==================== */

console.log('\n--- 9. 外壳与对话模型：左栏切换、消息正序、时间与标签 ---');
{
  const mkTurn = (id: string, question: string): TutorTurn => ({
    id,
    question,
    mode: 'hint',
    answer: { scope: 'in-material', basedOnMaterial: true, blocks: [] },
    stale: false,
    at: '2026-09-23T04:05:00.000Z',
  });

  const fakeHealth = {
    version: '0.1.0',
    modelProvider: 'mock',
    mock: true,
    verification: { available: true, engine: 'mathjs' },
  } as unknown as HealthResponse;

  /**
   * 当前选中的是哪个视图 —— 判据是**同一个 `<button>` 标签内**的 `data-view`：
   * 既不依赖属性顺序，也不依赖标签文字（「对话」项的标签是**会话标题**，会随状态变）。
   */
  function activeView(markup: string): string | null {
    const button = /<button[^>]*side-item-active[^>]*>/.exec(markup)?.[0] ?? '';
    return /data-view="([a-z]+)"/.exec(button)?.[1] ?? null;
  }

  /* --- 9a 左栏：功能/对话两类入口齐全，选中态可验证 --- */
  const navChat = render(
    '左栏（对话视图选中）',
    <SidebarNav wb={makeWb({ materials: [material] })} view="chat" onViewChange={() => {}} />,
  );
  check(
    '★ 五个功能入口的文字标签都在（不是只有图标）',
    ['材料', '知识点', '图谱', '练习', '画像'].every((label) => navChat.includes(label)),
    undefined,
  );
  check('★ 选中项带 aria-current="page"（不只靠颜色表达选中）', navChat.includes('aria-current="page"'));
  check(
    '★ 同时只有一项是选中态',
    [...navChat.matchAll(/aria-current="page"/g)].length === 1,
    [...navChat.matchAll(/aria-current="page"/g)].length,
  );
  check('★ 选中项就是对话视图', activeView(navChat) === 'chat', activeView(navChat));

  const navMaterial = render(
    '左栏（材料视图选中）',
    <SidebarNav wb={makeWb()} view="material" onViewChange={() => {}} />,
  );
  check(
    '★ 切到材料视图后选中态跟着走（不是写死在第一项）',
    activeView(navMaterial) === 'material',
    activeView(navMaterial),
  );
  check('★ 数字为 0 时不显示徽标（不用"0"凑数）', !navMaterial.includes('side-badge'));

  const navBadge = render(
    '左栏（材料 1 份）',
    <SidebarNav wb={makeWb({ materials: [material] })} view="chat" onViewChange={() => {}} />,
  );
  check('★ 徽标显示真实数字（材料 1 份 → 徽标 1）', /side-badge">1</.test(navBadge), undefined);

  /* --- 9b 对话模型：纯函数真值表 --- */
  const ordered = toChatMessages([mkTurn('1', '第一个问题'), mkTurn('2', '第二个问题')]);
  check('★ 消息条数 = 历史 × 2（一问一答）', ordered.length === 4, ordered.length);
  check(
    '★ 消息是正序：第一个问题在最前（对话流"新的在下"）',
    ordered[0]?.kind === 'user' && (ordered[0] as { text?: string }).text === '第一个问题',
    ordered[0],
  );
  check(
    '★ 最后两条是第二个问题的问答（顺序反了就成了旧版那样"新的在上"）',
    (ordered[2] as { text?: string }).text === '第二个问题' && ordered[3]?.kind === 'answer',
    ordered.slice(2),
  );

  const longQuestion = '为什么导数大于零就说明函数单调递增这件事需要证明吗';
  check(
    '★ 长问题压成一行标题（max + 省略号）',
    summarizeQuestion(longQuestion, 10) === `${longQuestion.slice(0, 10)}…`,
    summarizeQuestion(longQuestion, 10),
  );
  check('★ 换行折成空格（左栏一行放不下多行标题）', summarizeQuestion('第一行\n第二行') === '第一行 第二行');

  check('★ 非法时间不产生 NaN', formatClock('not-a-date') === '', formatClock('not-a-date'));
  const now = new Date('2026-09-23T12:00:00');
  check('★ 今天的标「今天」', formatRelativeDay('2026-09-23T09:00:00', now) === '今天');
  check('★ 昨天的标「昨天」', formatRelativeDay('2026-09-22T23:59:00', now) === '昨天');
  check(
    '★ 更早的标日期（按自然日算，不是"距今 N 小时"）',
    formatRelativeDay('2026-09-20T10:00:00', now) === '9月20日',
    formatRelativeDay('2026-09-20T10:00:00', now),
  );

  check(
    '★ 没有历史也没有材料时叫「新对话」（不编一个像模像样的名字）',
    deriveSessionLabel({ history: [], materials: [], sessionId: null }) === '新对话',
  );
  check(
    '★ 有历史时用第一个问题当标题',
    deriveSessionLabel({ history: [mkTurn('1', '切线怎么求')], materials: [], sessionId: 's-1' }) ===
      '切线怎么求',
  );
  check(
    '★ 只有材料时用材料首句当标题',
    deriveSessionLabel({ history: [], materials: [{ text: '本节讲导数' }], sessionId: 's-1' }) ===
      '本节讲导数',
  );
  check(
    '★ 没有会话时如实写「轻路径」（不写成"会话 1"）',
    describeSession({ sessionId: null, materialVersion: 0, materials: [], history: [] }).includes(
      '轻路径',
    ),
  );
  const sub = describeSession({
    sessionId: 's-1',
    materialVersion: 2,
    materials: [{ text: 'x' }],
    history: [mkTurn('1', 'q')],
  });
  check('★ 会话摘要报真实的份数与条数', sub.includes('材料 1 份') && sub.includes('问答 1 条'), sub);

  check('★ 没有动作在进行时不显示"正在…"', describePending(null) === null);
  check(
    '★ 每个动作都有对应的中文说法（不留 undefined）',
    ['knowledge', 'gap', 'tutor', 'quiz', 'profile'].every(
      (key) => typeof describePending(key) === 'string',
    ),
  );

  /* --- 9c 对话视图：空态与顺序 --- */
  const empty = render('对话视图（空态）', <ConversationView wb={makeWb()} mock={false} />);
  check(
    '★ 空态给的是可点的示例问题，而不是一段说明文字',
    empty.includes('问一个微积分问题') && empty.includes('切线方程是怎么求出来的？'),
  );
  check('★ 空态不再出现"还没有问答记录"这类说明性小字', !empty.includes('还没有问答记录'));

  const conv = render(
    '对话视图（一条问答）',
    <ConversationView wb={makeWb({ history: [mkTurn('1', '切线怎么求')] })} mock={false} />,
  );
  check(
    '★ 提问在上、回答在下（与旧版的倒序展示相反）',
    conv.indexOf('切线怎么求') < conv.indexOf('msg-answer'),
    { q: conv.indexOf('切线怎么求'), a: conv.indexOf('msg-answer') },
  );
  check('★ 输入区在对话流里（不是另一个面板）', conv.includes('composer-input'));
  check(
    '★ 回答模式的三个入口仍在（文案与 labels.ts 一致，不是另造新词）',
    ['给我提示', '解释概念', '查看完整解答'].every((text) => conv.includes(text)),
  );

  /* --- 9d 外壳：布局、真实性标注、提示位置 --- */
  const shell = render(
    '外壳（mock 通道 + 子内容）',
    <AppShell
      health={fakeHealth}
      healthError={null}
      wb={makeWb({ materials: [material] })}
      view="chat"
      onViewChange={() => {}}
      sideOpen={false}
      onToggleSide={() => {}}
    >
      <div>CHILD-MARK</div>
    </AppShell>,
  );
  check('★ 子内容进主区', shell.includes('CHILD-MARK'));
  check('★ 左栏与主区同时存在', shell.includes('class="side"') && shell.includes('shell-main'));
  check('★ mock 通道横幅保留（改版不许把它弄丢）', shell.includes('当前是 mock 演示通道'));
  check(
    '★ 四段如实标注仍在 DOM 里（只是收进「本页说明」折叠区，不是删掉）',
    ['本页说明', '本页尚未接入', '语音识别发生在哪里', '符号验证的边界'].every((text) =>
      shell.includes(text),
    ),
    undefined,
  );
  check('★ 折叠区默认收起（`<details>` 不带 open）', !/class="side-note"[^>]*open/.test(shell));
  const notImplemented = /本页尚未接入<\/strong><span>([\s\S]*?)<\/span>/.exec(shell)?.[1] ?? '';
  check(
    '★ 未接入清单里不再出现「图片」「语音」（V1.2/V1.3 修过的口径不许回退）',
    notImplemented.length > 0 && !notImplemented.includes('图片') && !notImplemented.includes('语音'),
    notImplemented.slice(0, 40),
  );

  const shellBusy = render(
    '外壳（正在处理中）',
    <AppShell
      health={fakeHealth}
      healthError={null}
      wb={makeWb({ anyBusy: true, busy: 'tutor' })}
      view="graph"
      onViewChange={() => {}}
      sideOpen={false}
      onToggleSide={() => {}}
    >
      <div>CHILD-MARK</div>
    </AppShell>,
  );
  check(
    '★ 处理中提示在主区顶部（非对话视图也能看到，不会只活在对话流里）',
    shellBusy.includes('notice-info') && shellBusy.includes('正在处理中'),
  );
  check('★ 正在处理时给「取消」（长任务不该只能干等）', shellBusy.includes('取消'));

  const shellRetry = render(
    '外壳（失败且可重试）',
    <AppShell
      health={fakeHealth}
      healthError={null}
      wb={makeWb({ notice: { kind: 'error', text: '模型调用失败', retryable: true }, canRetry: true })}
      view="chat"
      onViewChange={() => {}}
      sideOpen={false}
      onToggleSide={() => {}}
    >
      <div>CHILD-MARK</div>
    </AppShell>,
  );
  check('★ 可重试的失败才挂「重试」', shellRetry.includes('重试'));

  const shellNoRetry = render(
    '外壳（失败但不可重试）',
    <AppShell
      health={fakeHealth}
      healthError={null}
      wb={makeWb({
        notice: { kind: 'error', text: '提交失败了', retryable: false },
        canRetry: true,
      })}
      view="chat"
      onViewChange={() => {}}
      sideOpen={false}
      onToggleSide={() => {}}
    >
      <div>CHILD-MARK</div>
    </AppShell>,
  );
  check(
    '★ 不可重试的失败不挂按钮（I20⑤：有 canRetry 但没有 retryable 时不许挂）',
    !shellNoRetry.includes('重试'),
  );
}

/* ==================== 10. 会话归档（P2-2，2026-09-23） ==================== */

console.log('\n--- 10. 会话归档：上限、排序确定、容错、左栏历史 ---');
{
  const mkTurn = (id: string, question: string): TutorTurn => ({
    id,
    question,
    mode: 'hint',
    answer: { scope: 'in-material', basedOnMaterial: true, blocks: [] },
    stale: false,
    at: '2026-09-23T04:05:00.000Z',
  });

  const entry = (id: string, updatedAt: string, turns = 0): SessionHistoryEntry => ({
    sessionId: id,
    createdAt: updatedAt,
    updatedAt,
    materialVersion: 1,
    materials: [{ id: `m-${id}`, text: `材料-${id}` }],
    history: Array.from({ length: turns }, (_, index) =>
      mkTurn(`${id}-t${index}`, `问题 ${id} 第 ${index} 条`),
    ),
  });

  /* --- 10a 纯函数真值表（不依赖渲染） --- */
  const many = Array.from({ length: 60 }, (_, index) => mkTurn(`t${index}`, `第 ${index} 条`));
  const trimmed = trimTurns(many, 50);
  check('★ 问答超上限时裁到上限条数', trimmed.length === 50, trimmed.length);
  check(
    '★ 裁掉的是**最旧**的（保留最近才有用）',
    trimmed[0]?.question === '第 10 条' && trimmed[49]?.question === '第 59 条',
    [trimmed[0]?.question, trimmed[49]?.question],
  );
  check('未超上限时原样返回', trimTurns(many.slice(0, 3), 50).length === 3);

  const updated = upsertEntry(
    [entry('a', '2026-09-23T01:00:00.000Z')],
    entry('a', '2026-09-23T05:00:00.000Z'),
  );
  check('★ 同一会话再次 upsert 不会出现两条', updated.length === 1, updated.length);
  check('★ 内容取最新那次（updatedAt 被刷新）', updated[0]?.updatedAt === '2026-09-23T05:00:00.000Z');

  const ordered = upsertEntry(
    [entry('b', '2026-09-23T01:00:00.000Z'), entry('a', '2026-09-23T03:00:00.000Z')],
    entry('c', '2026-09-23T02:00:00.000Z'),
  );
  check(
    '★ 按 updatedAt 倒序（最近的在最前）',
    ordered.map((item) => item.sessionId).join('') === 'acb',
    ordered.map((item) => item.sessionId),
  );
  const tie = upsertEntry(
    [entry('z', '2026-09-23T01:00:00.000Z')],
    entry('a', '2026-09-23T01:00:00.000Z'),
  );
  const tieAgain = upsertEntry(
    [entry('z', '2026-09-23T01:00:00.000Z')],
    entry('a', '2026-09-23T01:00:00.000Z'),
  );
  check(
    '★ 时间相同时顺序仍然确定（否则断言会偶发失败）',
    tie.map((item) => item.sessionId).join('') === tieAgain.map((item) => item.sessionId).join(''),
    tie.map((item) => item.sessionId),
  );

  const capped = Array.from({ length: 12 }, (_, index) =>
    entry(`s${String(index).padStart(2, '0')}`, `2026-09-23T${String(index).padStart(2, '0')}:00:00.000Z`),
  ).reduce((list, item) => upsertEntry(list, item, 10), [] as SessionHistoryEntry[]);
  check('★ 会话数超上限时裁到上限', capped.length === 10, capped.length);

  check(
    '删除按 sessionId 生效',
    removeEntry([entry('a', 'x'), entry('b', 'y')], 'a').length === 1,
  );

  check('★ 存储内容损坏时降级为空（不抛错）', parseEntries('{ 这不是 JSON').length === 0);
  check('★ 不是数组时降级为空', parseEntries('{"sessionId":"x"}').length === 0);
  check('★ 缺字段的条目被过滤掉（不把脏数据当历史）', parseEntries('[{"sessionId":"x"}]').length === 0);
  check(
    '合法条目能读回',
    parseEntries(JSON.stringify([entry('a', '2026-09-23T01:00:00.000Z')])).length === 1,
  );
  check('null / 空串降级为空', parseEntries(null).length === 0 && parseEntries('').length === 0);

  /* --- 10b 左栏历史列表 --- */
  const currentEntry = entry('cur', '2026-09-23T06:00:00.000Z');
  const pastEntry = entry('old', '2026-09-22T06:00:00.000Z');
  const navWithHistory = render(
    '左栏（有一条历史会话）',
    <SidebarNav
      wb={makeWb({ sessionId: 'cur', historyEntries: [currentEntry, pastEntry] })}
      view="chat"
      onViewChange={() => {}}
    />,
  );
  check('★ 有历史时出现「历史会话」组', navWithHistory.includes('历史会话'));
  check('★ 历史条目显示它自己的标题（取自该会话的材料/首问）', navWithHistory.includes('材料-old'));
  check(
    '★ 列表里**不重复**当前会话（它在「对话」组里已经显示过）',
    !navWithHistory.includes('材料-cur'),
    undefined,
  );
  check(
    '★★ 底部如实说明"仅本标签页保存，关闭标签页即清空"（不说明会被当成云端历史）',
    navWithHistory.includes('仅本标签页保存'),
  );

  const navNoHistory = render(
    '左栏（没有历史）',
    <SidebarNav wb={makeWb()} view="chat" onViewChange={() => {}} />,
  );
  check('★ 没有历史时整组不出现（不留空壳标题）', !navNoHistory.includes('历史会话'));
}

/* ==================== 11. 教师视图（P-A6，2026-09-23） ==================== */

console.log('\n--- 11. 教师视图：样本不足提示、分布表、覆盖热力、脱敏 ---');
{
  const aggregate = (students: number): ClassAggregate => ({
    classId: 'demo',
    studentCount: students,
    mastery: {
      'kp-monotonicity': {
        LOCAL: 2,
        SUPPLEMENTED: 1,
        MISSING: 1,
        PENDING: 0,
        VERIFIED: 2,
        DISPUTED: 0,
      },
    },
    misconceptions: [
      { kind: 'concept-misunderstanding', pattern: '把导数为零当成极值点', count: 3 },
    ],
    coverageHeat: [
      { materialId: 'm-1', conceptId: 'kp-monotonicity', covered: true },
      { materialId: 'm-1', conceptId: 'kp-derivative', covered: false },
    ],
    updatedAt: '2026-09-23T08:00:00.000Z',
  });

  const empty = render('教师视图（未读取）', <TeacherPanel wb={makeWb()} />);
  check('★ 未读取时给引导，而不是留一片空白', empty.includes('点「刷新」读取班级聚合'));
  check(
    '★★ 始终写明「演示级：当前所有会话视为一个班」—— 否则会被当成真实班级数据',
    empty.includes('演示级'),
  );
  check('★ 样本为 0 时也说清样本不足', empty.includes('样本不足') === false && empty.includes('尚未读取'));

  const few = render(
    '教师视图（样本不足）',
    <TeacherPanel wb={makeWb({ teacher: aggregate(2) })} />,
  );
  check('★ 样本低于 TEACHER_MIN_SAMPLE 时提示「样本不足」', few.includes('样本不足'));
  check('★ 样本不足时**不画分布**（2 个学生的分布会被当成结论）', !few.includes('有争议'));

  const enough = render(
    '教师视图（样本充足）',
    <TeacherPanel wb={makeWb({ teacher: aggregate(6) })} />,
  );
  check('★ 样本够时出现六态表头', enough.includes('已覆盖') && enough.includes('有争议'));
  check(
    '★ 覆盖热力用**文字**标注状态（不只靠颜色，色觉差异下也能读）',
    enough.includes('未覆盖'),
  );
  check('★ 误区按其 pattern 渲染', enough.includes('把导数为零当成极值点'));
  check(
    '★★ 界面侧也不出现学生标识（脱敏在客户端同样成立）',
    !/sessionId/.test(enough) && !enough.includes('真实学生'),
  );
}

/* ==================== 12. 用户页 / 登录（2026-09-23） ==================== */

console.log('\n--- 12. 用户页：登录表单、账号信息、教师端按角色开放 ---');
{
  const accountOf = (
    username: string,
    displayName: string,
    role: 'student' | 'teacher',
  ): AccountInfo => ({
    username,
    displayName,
    role,
    classId: 'demo',
    signedInAt: '2026-09-23T08:00:00.000Z',
  });

  const guest = render('用户页（未登录）', <AccountView wb={makeWb()} onBack={() => {}} />);
  check('★ 未登录时给的是登录表单（用户名 ＋ 口令）', guest.includes('用户名') && guest.includes('口令'));
  check(
    '★★ 演示账号与缺省口令写在明面上 —— 不写，演示时没人知道该输什么',
    guest.includes('student') && guest.includes('teacher') && guest.includes('demo'),
  );
  check('★ 明说"不登录也能用工作台"', guest.includes('不登录也能直接用学习工作台'));

  const student = render(
    '用户页（学生已登录）',
    <AccountView wb={makeWb({ account: accountOf('student', '同学', 'student') })} onBack={() => {}} />,
  );
  check('★ 显示用户名与角色', student.includes('student') && student.includes('学生'));
  check(
    '★★ 学生看不到教师端按钮，但有**如实说明**（不是把入口藏掉让人以为没这功能）',
    student.includes('仅教师账号'),
  );

  const teacher = render(
    '用户页（教师已登录）',
    <AccountView wb={makeWb({ account: accountOf('teacher', '老师', 'teacher') })} onBack={() => {}} />,
  );
  check(
    '★ 教师账号能看到教师端的「进入」（且不再显示"仅教师账号"）',
    teacher.includes('进入') && !teacher.includes('仅教师账号'),
  );
  check('★ 有退出登录', teacher.includes('退出登录'));
}

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
