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
import type { GraphNeighborhood, LearnerProfile } from '@lc/contracts';
import type {
  GapRecord,
  TutorTurn,
  UiMaterial,
  WorkbenchActions,
  WorkbenchState,
} from '../src/hooks/useWorkbench';
import { GraphPanel } from '../src/components/GraphPanel';
import { KnowledgePanel } from '../src/components/KnowledgePanel';
import { MaterialPanel } from '../src/components/MaterialPanel';
import { ProfilePanel } from '../src/components/ProfilePanel';
import { QuizPanel } from '../src/components/QuizPanel';
import { TutorPanel } from '../src/components/TutorPanel';

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
    dismissNotice: () => {},
    notify: () => {},
    ensureMaterialSession: async () => 's-1',
    isBusy: () => false,
    retryLastFailed: noop,
    focusNode: () => {},
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
  check('★ 语音入口存在（A1 要求三入口齐全）', html.includes('上传语音'));
}

{
  const html = render('材料面板（mock）', <MaterialPanel wb={makeWb({ materials: [material] })} mock />);
  check('★ mock 通道有可见提示，不冒充真实输出', html.includes('演示通道'), null);
  check('mock 提示含"不代表真实模型"', html.includes('不代表真实模型'));
}

{
  // 未接入的识别通道必须如实列出（§9）
  const html = render(
    '材料面板（有未接入通道）',
    <MaterialPanel wb={makeWb({ materials: [material], parseUnavailable: ['formula'] })} mock={false} />,
  );
  check('★ 如实列出未接入的识别环节', html.includes('公式识别（LaTeX）'), null);
  check('说明材料按纯文本参与解析', html.includes('纯文本'));
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

  const plain = render('答疑面板（真实通道）', <TutorPanel wb={makeWb({ history: [turn] })} mock={false} />);
  check('回答块标出验证状态', plain.includes('未验证'));
  check('★ 真实通道不出现 mock 标记', !plain.includes('mock 演示数据'));
  check('标明是否基于材料', plain.includes('基于你的材料'));

  const mocked = render('答疑面板（mock 通道）', <TutorPanel wb={makeWb({ history: [turn] })} mock />);
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
    <TutorPanel wb={makeWb({ history: [dropped] })} mock={false} />,
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
  check('★ 出题按钮被禁用（不是点下去才报错）', /<button class="btn"[^>]*disabled/.test(blocked), null);
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

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
