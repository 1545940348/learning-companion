/**
 * 三张教学示意图的画法（`P-B15`，2026-09-23）—— B 负责
 *
 * ### 画的是什么，不是什么
 *
 * 画的是**程序生成的函数示意图**：坐标轴、网格、曲线、切线/割线、关键点标记。
 * **不是教材插图**，也不含任何外部版权素材 —— 所以它可以直接进仓库。
 *
 * 三张图与三个主题一一对应（导数 / 切线 / 单调性）。标注**一律 ASCII 大写**，
 * 中文讲解在同名 `.md` 题注与 `index.json` 的 `figure.caption` 里
 * （点阵字库画不了汉字，见 `lib/font5x7.mjs`）。
 *
 * ### 每个标注的位置都是**算过**的，不是试出来的
 *
 * `tag()` 的白底会盖住底下的东西，所以凡是放 `tag` 的地方，注释里都写了
 * "这块带子里曲线/直线的取值范围是多少、为什么碰不到标注框"。
 * 第一版把 `Q(2,4)` 直接压在抛物线上，白底在曲线中间啃出一个方口 —— 那种错
 * **跑测试跑不出来**（字节一致、尺寸正确、能被识别），只有人看一眼才知道。
 *
 * ### 单调性那张图**刻意不定义** F'(X)
 *
 * `P-B15` 的验收写明"单调性素材**必须保留导数前置缺口**（演示案例的前提）"。
 * 图里出现 `F'(X)>0` 却从不解释 `F'` 是什么 —— 这正是缺口本身，不是疏漏，
 * 所以图例里那行 `F-PRIME NOT DEFINED HERE` 是**故意印上去的**。
 */

import { Canvas } from './lib/png.mjs';
import { missingGlyphs } from './lib/font5x7.mjs';
import { COLOR, HEIGHT, WIDTH, drawAxes, drawLegend, makeFrame, plotFunction, tag } from './lib/canvas-kit.mjs';

/* ==================== 图 1：导数（切线是割线的极限） ==================== */

function drawDerivative() {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const frame = makeFrame(-2.4, 2.6, -1.4, 6.4);
  drawAxes(canvas, frame);

  const f = (x) => x * x;
  plotFunction(canvas, frame, f, COLOR.curve, -2.4, 2.4);

  /*
   * 割线穿过 (1,1) 与 (2,4)：斜率 3 ⇒ y = 3x - 2。
   * 切线在 x=1 处：f'(x)=2x ⇒ 斜率 2 ⇒ y = 2x - 1。
   * 两条都从图里截取一段画，不给无限直线 —— 图幅有限，画到边就是"这条线还延长出去"。
   */
  canvas.line(frame.px(0.24), frame.py(3 * 0.24 - 2), frame.px(2.24), frame.py(3 * 2.24 - 2), COLOR.secant);
  canvas.line(frame.px(-0.2), frame.py(2 * -0.2 - 1), frame.px(2.4), frame.py(2 * 2.4 - 1), COLOR.tangent);

  canvas.box(frame.px(1), frame.py(1), 5, COLOR.marker);
  canvas.box(frame.px(2), frame.py(4), 5, COLOR.marker);

  /* 抛物线顶点在 (0,0) 且向右上方张开 ⇒ y>5.7 的整条带子只有曲线头部，留白 */
  tag(canvas, 'F(X)=X^2', frame.px(-2.2), frame.py(6.0), COLOR.curve);

  /*
   * 两个点的名字**只写一个字母**，紧挨着标记画。
   *
   * 为什么不用 `P(1,1)` 这种完整写法：那个标注框 6 个字符宽，无论放哪都会压住
   * 曲线（第一版就压在抛物线上，白底啃出一个方口）。一个字母只占 12px，
   * 塞得进标记旁边的缝里；坐标改由图例给 —— 图例在绘图区外，压不到任何东西。
   *
   * P：框 y∈[0.55,0.98]，而 x² 在 x∈[1.08,1.18] 上是 1.17~1.39，切线 1.16~1.36，
   * 割线 1.24~1.54 —— 三条都在框上方。
   * Q：框 y∈[3.40,3.83]，而 x² 在 x∈[2.05,2.15] 上是 4.20~4.62，割线 4.15~4.45 —— 同上。
   */
  tag(canvas, 'P', frame.px(1.08), frame.py(0.55), COLOR.marker);
  tag(canvas, 'Q', frame.px(2.05), frame.py(3.4), COLOR.marker);

  drawLegend(canvas, [
    { color: COLOR.tangent, text: 'TANGENT AT P(1,1)  SLOPE=2' },
    { color: COLOR.secant, text: 'SECANT PQ, Q(2,4)  SLOPE=3' },
  ]);
  return canvas;
}

/* ==================== 图 2：切线（一点与一个斜率定一条直线） ==================== */

function drawTangent() {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const frame = makeFrame(-2.3, 2.3, -3.4, 3.4);
  drawAxes(canvas, frame);

  const f = (x) => x ** 3 - 3 * x;
  plotFunction(canvas, frame, f, COLOR.curve, -2.3, 2.3);

  /*
   * 切点取 x=-1.5：f(-1.5) = -3.375 + 4.5 = 1.125，f'(-1.5) = 6.75 - 3 = 3.75。
   * 切线 y = 3.75x + 6.75。
   *
   * ### 为什么**不是** x=0.5（这是改过一次的地方）
   *
   * 原先取 x=0.5，斜率 -2.25，切线 y = -2.25x - 0.25。它在 x=-1 处恰好等于 2 ——
   * 也就是**正好穿过曲线自己的极大值点 (-1,2)**。这不是画错：把切点 t 代进去解
   * `f(t)+f'(t)(-1-t) = 2` 得 `(t-1)²(2t+1)=0`，即 t=1 或 t=-1/2，
   * 而 1/2 正是 -1/2 的奇对称像（f 是奇函数）。
   *
   * 结果那张图**看着像一条在两个地方都贴上曲线的直线** —— 对"切线是什么"这个主题
   * 是帮倒忙，比不画更糟。换到 x=-1.5 后另一个交点在 x=3（把
   * `f(x)-(3.75x+6.75) = (x+1.5)²(x-3)` 分解即知），落在图幅之外，
   * 图里就只剩"碰一下、然后分开"这一个事实。
   */
  const slope = 3.75;
  const at = 6.75;
  canvas.line(frame.px(-2.3), frame.py(slope * -2.3 + at), frame.px(-0.893), frame.py(slope * -0.893 + at), COLOR.tangent);

  // 从切点垂直落到 x 轴：把"横坐标 -1.5"这件事画出来
  canvas.dashedLine(frame.px(-1.5), frame.py(1.125), frame.px(-1.5), frame.py(0), COLOR.marker);
  canvas.box(frame.px(-1.5), frame.py(1.125), 5, COLOR.marker);

  /*
   * 函数式挪到**右上角**：左上角现在被切线占了（切线在 x∈[-2.3,-0.89] 上从 -1.875
   * 升到 3.375），再往那儿放字必然被压。右上角 x∈[0.95,2.03] 的曲线值 1.9~2.28，
   * 够不着标注框（y∈[2.95,3.38]）—— 曲线要到 x≈2.09 才升过 2.9。
   *
   * 切点横坐标**不在图里标**，只画虚线落到 x 轴 + 在图例里给出「TANGENT AT X=-1.5」。
   * 试过在图里写 `X=-1.5`：这块图幅的曲线和切线把空白切得七零八落，
   * 标注放哪都会压住其中之一（三个候选位置都试过）。**放不下就别硬塞**，
   * 图例里那句话说清楚了，比一个压着曲线的标签强。
   */
  tag(canvas, 'F(X)=X^3-3X', frame.px(0.95), frame.py(2.95), COLOR.curve);

  drawLegend(canvas, [
    { color: COLOR.tangent, text: 'TANGENT AT X=-1.5  SLOPE=3.75' },
    { color: COLOR.marker, text: 'DASHED: X OF THE TANGENT POINT' },
  ]);
  return canvas;
}

/* ==================== 图 3：单调性（**保留 F'(X) 不解释的缺口**） ==================== */

function drawMonotonicity() {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const frame = makeFrame(-2.3, 2.3, -3.4, 3.4);
  drawAxes(canvas, frame);

  const f = (x) => x ** 3 - 3 * x;
  const derivativeSign = (x) => 3 * x * x - 3; // f'(x) = 3(x-1)(x+1)

  /*
   * 按导数符号给曲线上色：正（递增）蓝、负（递减）橙。
   * **这正是缺口所在**：图里用 `F'(X)` 分了段，却从头到尾不解释 `F'` 是什么 ——
   * 学生看到"颜色按 F'(X) 的正负分"，但 F' 在本素材里没有定义（见题注与 index.json）。
   */
  const segments = [
    [-2.3, -1],
    [-1, 1],
    [1, 2.3],
  ];
  for (const [from, to] of segments) {
    const mid = (from + to) / 2;
    plotFunction(canvas, frame, f, derivativeSign(mid) > 0 ? COLOR.increase : COLOR.decrease, from, to);
  }

  // 两个分界点：正是 f'=0 的地方（图里只说"这里换色"，不说为什么）
  for (const x of [-1, 1]) {
    canvas.dashedLine(frame.px(x), frame.py(f(x)), frame.px(x), frame.py(0), COLOR.marker);
    canvas.box(frame.px(x), frame.py(f(x)), 5, COLOR.marker);
  }

  /*
   * 三处短标注的位置都对着函数值核过（见 `drawDerivative` 的同类注释）：
   * 上排两处取 y∈[2.9,3.33]，该带子里曲线最高只到 2（在 x=-1）；
   * 中间那处取 y∈[-3.0,-2.57]，此处曲线最低只到 -2（在 x=±1）—— 都碰不到。
   */
  tag(canvas, "F'(X)>0", frame.px(-2.15), frame.py(2.9), COLOR.increase);
  tag(canvas, "F'(X)<0", frame.px(-0.78), frame.py(-3.0), COLOR.decrease);
  tag(canvas, "F'(X)>0", frame.px(1.15), frame.py(2.9), COLOR.increase);

  /*
   * ⚠️ 图例里这一行是**刻意的**，不是自嘲文案：
   * `P-B15` 要求单调性素材**保留导数前置缺口**。图里用了 `F'(X)` 却从不解释它是什么 ——
   * 把"这里没定义"直接印在图上，缺口就成了**看得见的事实**，
   * 而不是只在文档里写一句、图却看起来自洽。
   */
  drawLegend(canvas, [
    { color: COLOR.increase, text: "F'(X)>0  UP" },
    { color: COLOR.decrease, text: "F'(X)<0  DOWN" },
    { color: COLOR.marker, text: "F-PRIME NOT DEFINED HERE" },
  ]);
  return canvas;
}

/* ==================== 清单 ==================== */

/**
 * 三张图的清单。`topic` 与文字/语音素材**同名对应** ——
 * `index.json` 靠它对上"3 主题 × 3 形态"的正交关系。
 */
export const FIGURES = [
  {
    id: 'derivative',
    topic: 'derivative',
    file: 'derivative.png',
    title: '导数的几何意义：切线是割线的极限',
    caption: '抛物线 F(X)=X^2 上取 P(1,1) 与 Q(2,4)；绿线是过两点的**割线**，红线是 P 处的**切线**。',
    draw: drawDerivative,
  },
  {
    id: 'tangent',
    topic: 'tangent',
    file: 'tangent.png',
    title: '切线：一点加一个斜率定一条直线',
    caption: '曲线 F(X)=X^3-3X 在 X=-1.5 处的切线（红），斜率 3.75；虚线把切点的横坐标落到 x 轴上。',
    draw: drawTangent,
  },
  {
    id: 'monotonicity',
    topic: 'monotonicity',
    file: 'monotonicity.png',
    title: "单调性：按 F'(X) 的符号给曲线分段着色（**F' 未定义**）",
    caption: "同一曲线按 F'(X) 的正负分成蓝（>0）与橙（<0）三段。**本素材不解释 F' 是什么** —— 导数前置缺口见图注与 index.json。",
    draw: drawMonotonicity,
  },
];

/** 按 id 取一张图的定义（找不到抛错，不返回 undefined 让调用处崩在别处） */
export function findFigure(id) {
  const figure = FIGURES.find((item) => item.id === id);
  if (!figure) throw new Error(`没有这张图：${id}。可选：${FIGURES.map((f) => f.id).join(' / ')}`);
  return figure;
}

/**
 * 自查：图里的 ASCII 标注字必须都画得出来。
 *
 * 画不出的字会变成方框 —— 那种图**看着还是"有标注"**，只有人凑近才发现是乱码，
 * 所以在生成时就报错，把问题拦在这里而不是演示现场。
 *
 * 中文标题/题注**不在检查范围内**：它们本来就不画进图里（点阵字库画不了汉字），
 * 所以先按"整串是不是纯 ASCII"过滤掉，只查真正会被画出来的那些。
 */
export function checkGlyphs() {
  const problems = [];
  for (const figure of FIGURES) {
    for (const text of [figure.title, figure.caption]) {
      if (!/^[\x20-\x7e]*$/.test(text)) continue;
      const missing = missingGlyphs(text);
      if (missing.length > 0) problems.push(`${figure.id}：图注里有画不出的字符 ${missing.join('')}`);
    }
  }
  return problems;
}
