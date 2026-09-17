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
}

/* ==================== 5. 练习 ==================== */

console.log('\n--- 5. 练习面板 ---');
{
  const html = render('练习面板', <QuizPanel wb={makeWb()} />);
  check('提交前不展示答案的说明存在', html.includes('答案在你提交之前不会显示'));
  check('★ 说明自编题解析不算材料证据', html.includes('不算作你材料的证据'));
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
}

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
