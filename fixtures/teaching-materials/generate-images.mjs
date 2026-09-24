/**
 * 教学素材的图片生成入口（`P-B15`，2026-09-23）—— B 负责
 *
 * ### 为什么图必须"生成得出来"而不是贴进来
 *
 * 贴一张图进仓库，没人知道它是怎么来的、还能不能重做。本脚本把每张图
 * **从源码确定性地产出**（不写时间戳、压缩参数写死），于是 `verify:flow` 可以断言：
 * 仓库里那份 PNG 与**现在重新生成**的结果**逐字节相同**。
 * 图片因此和代码一样受版本控制与审查。
 *
 * ### 三个文件的分工
 *
 * | 文件 | 管什么 |
 * |---|---|
 * | `lib/png.mjs` | PNG 编码 + 画布（画点/线/矩形/虚线/文字） |
 * | `lib/font5x7.mjs` | 5×7 点阵字库（ASCII，零依赖） |
 * | `lib/canvas-kit.mjs` | 画图公共零件（坐标映射、坐标轴、标注、图例） |
 * | `figures.mjs` | **三张图画什么**（每张的标注位置都算过，见那里的注释） |
 * | 本文件 | 命令行入口与"生成 / 比对"两个动作 |
 *
 * 拆开是因为原先全在一个文件里，394 行，超过项目 300 行的阈值（`I43`）。
 * 那个阈值扫的是 `apps/` 与 `packages/`，`fixtures/` 不在扫描范围内 ——
 * 但它不会报红**不代表可以超**，所以还是拆了。
 *
 * ### 用法
 *
 * ```bash
 * node fixtures/teaching-materials/generate-images.mjs         # 覆盖写 images/
 * node fixtures/teaching-materials/generate-images.mjs --check  # 只比对，不写（verify 用）
 * ```
 *
 * ### 输出确定性的两个前提（改代码时别破坏）
 *
 * 1. **不写 `tIME` 块**：PNG 允许带时间戳，带上就每次字节都不同；
 * 2. **zlib 压缩参数写死**（`level: 9`）：参数影响字节流，不写死就没有可复现性可言。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPngSize } from './lib/png.mjs';
import { FIGURES, checkGlyphs, findFigure } from './figures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'images');

export { FIGURES, checkGlyphs };

/** 生成一张图的字节。**同一输入必得同一输出**（verify 靠这个比对） */
export function buildImage(id) {
  return findFigure(id).draw().toPng();
}

/** 生成全部（`Map<id, Buffer>`） */
export function buildAll() {
  return new Map(FIGURES.map((figure) => [figure.id, buildImage(figure.id)]));
}

function main() {
  const problems = checkGlyphs();
  if (problems.length > 0) {
    console.error(`图里有画不出的字符（会渲染成方框）：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  if (process.argv.includes('--check')) {
    const stale = [];
    for (const [id, buffer] of buildAll()) {
      if (!readFileSync(join(OUT_DIR, findFigure(id).file)).equals(buffer)) {
        stale.push(findFigure(id).file);
      }
    }
    if (stale.length > 0) {
      console.error(`图片与源码不一致（需要重新生成）：${stale.join(' / ')}`);
      process.exit(1);
    }
    console.log(`图片与源码一致：${FIGURES.length} 张，逐字节相同`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [id, buffer] of buildAll()) {
    const figure = findFigure(id);
    writeFileSync(join(OUT_DIR, figure.file), buffer);
    const size = readPngSize(buffer);
    console.log(`${figure.file}  ${size.width}×${size.height}  ${buffer.length} 字节`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
