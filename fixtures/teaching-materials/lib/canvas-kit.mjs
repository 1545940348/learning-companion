/**
 * 画函数示意图的公共零件（`P-B15`，2026-09-23）。
 *
 * 把"三张图都要用的东西"集中在这里：画布尺寸、绘图区、配色、坐标映射、
 * 坐标轴与网格、标注、图例条、函数曲线采样。
 * 具体的三张图在 `../figures.mjs`，命令行入口在 `../generate-images.mjs`。
 *
 * ### 为什么要拆成三个文件
 *
 * 一开始全写在一个 `generate-images.mjs` 里，394 行 —— 超过项目 300 行的阈值
 * （`I43`）。那个阈值扫的是 `apps/` 与 `packages/`，`fixtures/` 不在扫描范围内，
 * 所以它不会报红；但**自己定的规矩，不该给自己的文件开例外**。
 *
 * ### `bottom` 为什么只到 352
 *
 * 下面 88px 留给**图例条**（见 `drawLegend`）：长标注
 * （"TANGENT AT X=-1.5 SLOPE=3.75"）画在图里必然压住曲线，
 * 而一张"标注把要标注的东西盖住了"的图是自相矛盾的。图例条是教材的常规做法，
 * 也让三张图的配色说明有统一位置。
 */

import { measure } from './font5x7.mjs';

export const WIDTH = 640;
export const HEIGHT = 440;

/** 绘图区（留边给坐标轴刻度），四边都是像素 */
export const PLOT = { left: 64, right: 616, top: 36, bottom: 352 };

/** 图例条的第一行基线；行距 24px，两行到 390 为止（< 440） */
export const LEGEND_TOP = 366;
export const LEGEND_ROW_HEIGHT = 24;

export const COLOR = {
  axis: [70, 74, 82],
  grid: [228, 231, 236],
  curve: [30, 92, 200],
  increase: [30, 92, 200],
  decrease: [214, 118, 20],
  tangent: [200, 44, 44],
  secant: [18, 140, 82],
  marker: [40, 42, 48],
  text: [28, 30, 34],
};

/**
 * 造一个坐标映射器：数学坐标 ⇄ 像素坐标。
 *
 * 单独抽出来是因为**三张图的定义域各不相同**，而"把 (x, f(x)) 画到像素上"
 * 这件事只该写一次。y 轴要**翻过来**（屏幕 y 向下、数学 y 向上）——
 * 这是最容易写反、写反了图会上下颠倒却仍然"看起来像条曲线"的地方。
 */
export function makeFrame(xMin, xMax, yMin, yMax) {
  const px = (x) => PLOT.left + ((x - xMin) / (xMax - xMin)) * (PLOT.right - PLOT.left);
  const py = (y) => PLOT.bottom - ((y - yMin) / (yMax - yMin)) * (PLOT.bottom - PLOT.top);
  return { px, py, xMin, xMax, yMin, yMax };
}

/** 网格 + 坐标轴 + 轴名。三张图共用，避免各画各的导致观感不一致 */
export function drawAxes(canvas, frame) {
  for (let x = Math.ceil(frame.xMin); x <= frame.xMax; x += 1) {
    canvas.line(frame.px(x), PLOT.top, frame.px(x), PLOT.bottom, COLOR.grid);
  }
  for (let y = Math.ceil(frame.yMin); y <= frame.yMax; y += 1) {
    canvas.line(PLOT.left, frame.py(y), PLOT.right, frame.py(y), COLOR.grid);
  }
  // 坐标轴本身画在 x=0 / y=0 上；若 0 不在视野内就贴边（三张图里都在）
  const axisY = frame.py(Math.min(Math.max(0, frame.yMin), frame.yMax));
  const axisX = frame.px(Math.min(Math.max(0, frame.xMin), frame.xMax));
  canvas.line(PLOT.left, axisY, PLOT.right, axisY, COLOR.axis);
  canvas.line(axisX, PLOT.top, axisX, PLOT.bottom, COLOR.axis);
  // 轴名：X 在右端，Y 在顶端
  canvas.text('X', PLOT.right - 4, axisY + 6, COLOR.axis, 2);
  canvas.text('Y', axisX + 6, PLOT.top - 26, COLOR.axis, 2);
}

/**
 * 带白底的标注。**白底是必要的**：曲线和网格会把字压掉，
 * 而一张标注看不清的图等于没有标注。
 *
 * ⚠️ 白底会**盖住底下的东西**，所以调用处的位置必须选在真正的空白区 ——
 * 第一版把 `Q(2,4)` 直接压在曲线上，白底就在抛物线中间啃出一个方口。
 * 现在长的说明性标注一律进图例条（`drawLegend`），图里只留短标注，
 * 且每个位置都对着函数值核过（见 `figures.mjs` 各处的注释）。
 */
export function tag(canvas, content, x, y, color, scale = 2) {
  const { width, height } = measure(content, scale);
  canvas.fillRect(x - 3, y - 3, width + 6, height + 6, [255, 255, 255]);
  canvas.text(content, x, y, color, scale);
  return { width, height };
}

/**
 * 图例条：色块 + 说明，从左到右排，排满一行自动换行。
 *
 * 图例是**唯一放长标注的地方** —— 它在绘图区之外，压不到任何曲线，
 * 因此可以放心用完整句子（"SLOPE=3.75"、"F-PRIME NOT DEFINED HERE"）。
 */
export function drawLegend(canvas, entries) {
  let x = PLOT.left;
  let y = LEGEND_TOP;
  for (const entry of entries) {
    const width = measure(entry.text, 2).width;
    if (x > PLOT.left && x + 18 + width > PLOT.right) {
      x = PLOT.left;
      y += LEGEND_ROW_HEIGHT;
    }
    canvas.fillRect(x, y, 12, 12, entry.color);
    canvas.text(entry.text, x + 18, y + 2, COLOR.text, 2);
    x += 18 + width + 28;
  }
}

/** 采样一条函数曲线并画出来；`from`/`to` 是数学坐标 */
export function plotFunction(canvas, frame, fn, color, from, to) {
  const steps = Math.max(2, Math.round(frame.px(to) - frame.px(from)));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = from + ((to - from) * i) / steps;
    points.push([frame.px(x), frame.py(fn(x))]);
  }
  canvas.polyline(points, color);
}
