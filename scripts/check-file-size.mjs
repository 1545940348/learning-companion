/**
 * 文件体积检查（拆分阶段 0 · 卡 5）
 *
 * ### 为什么需要它
 *
 * 计划书 §3.3 的 `D-08`：`useWorkbench.ts` 一个文件 858 行（现为 924 行）= 13 个
 * `useState` + 27 个 action + 10 个端点编排 + 版本护栏 + 错误重试 + 持久化 + 六态派生。
 * 单人模块内的认知负担过重，任何改动都要通读全局。
 * 单测能锁行为，但**锁不住"这个文件正在变成上帝模块"** —— 那需要一个体积闸门。
 *
 * ### 阶段 0 口径：只告警，不阻断
 *
 * 计划书阶段 4 的验收才是"任一文件 ≤ 300 行"（且那时 `check-file-size` 转阻断）。
 * 现在就设成阻断会让命令恒红（`useWorkbench.ts` 924 行、`index.css` 951 行），
 * 于是没人再看它。**先让它能跑、能看到现状与差距**。
 *
 * ### 用法
 *
 *   node scripts/check-file-size.mjs            # 报告超阈值文件（默认 300 行）
 *   node scripts/check-file-size.mjs --limit 500
 *   node scripts/check-file-size.mjs --self-check   # 自检：故意造一个超限文件，必须被报出来
 *
 * ### 关于自检（`--self-check`）
 *
 * 本项目已经吃过一次"恒真断言"的亏（`I24`：`verify-serve-web` 第 3 节那条断言
 * 在任何实现下都成立）。所以这里自带红/绿证据：自检会**临时造**一个超限文件，
 * 断言脚本必须能报出它，然后清理。**报告为空的脚本不等于检查生效**。
 */

import { readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_LIMIT = 300;

/** 只数真正影响可维护性的源码；产物、依赖、文档都不看 */
const SCAN_DIRS = ['apps/web/src', 'apps/server/src', 'packages/contracts/src', 'packages/teaching/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'deploy-dist', '.learnbuddy', '.git']);

async function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在（如未构建）→ 跳过，不是错误
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** 数行数：按 `\n` 切。末尾无换行的最后一行业算一行（与 `wc -l` 的差异要明知） */
async function countLines(file) {
  const text = await readFile(file, 'utf8');
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

async function report(limit, { quiet = false } = {}) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    files.push(...(await collectFiles(dir)));
  }
  const rows = [];
  for (const file of files) {
    const lines = await countLines(file);
    if (lines > limit) rows.push({ file: file.replace(/\\/g, '/'), lines });
  }
  rows.sort((a, b) => b.lines - a.lines);

  if (!quiet) {
    console.log(`\n=== 文件体积检查（阈值 ${limit} 行，阶段 0 只告警）===`);
    if (rows.length === 0) {
      console.log(`  没有超过 ${limit} 行的源码文件。`);
    } else {
      console.log(`  超过阈值的文件 ${rows.length} 个（阶段 4 的目标是 0 个，且那时会转阻断）：`);
      for (const row of rows) {
        console.log(`  [注意] ${String(row.lines).padStart(5)} 行  ${row.file}`);
      }
    }
    console.log(`  扫描 ${files.length} 个源码文件。\n`);
  }
  return rows;
}

const args = process.argv.slice(2);
const limitIndex = args.indexOf('--limit');
const limit = limitIndex === -1 ? DEFAULT_LIMIT : Number(args[limitIndex + 1]);
if (!Number.isFinite(limit) || limit <= 0) {
  console.error('--limit 需要一个正数');
  process.exit(2);
}

if (args.includes('--self-check')) {
  /*
   * 自检：临时造一个 400 行文件，脚本必须把它报出来。
   * 造在系统临时目录（**不放进仓库**，本环境"造出来就得能删"，且临时目录不污染 git status）。
   */
  const dir = await mkdtemp(join(tmpdir(), 'lc-size-selfcheck-'));
  const big = join(dir, 'big.ts');
  await writeFile(big, `${'// filler\n'.repeat(400)}`, 'utf8');
  const lines = await countLines(big);
  const detected = lines > limit;
  await rm(dir, { recursive: true, force: true });
  console.log(`\n=== 自检：400 行的文件是否会被报出（阈值 ${limit}）===`);
  console.log(`  行数识别=${lines}（应为 400）、判定超限=${detected}（应为 true）`);
  if (lines !== 400 || !detected) {
    console.error('  ✗ 自检失败：体积检查在这些前提下不生效，报告为"无超限文件"也不可信。');
    process.exit(1);
  }
  console.log('  ✓ 自检通过：超限文件确实会被报出来。\n');
}

const rows = await report(limit);
// 阶段 0 只告警：**永远退出码 0**（除非自检失败）。阶段 4 转阻断时改成 `rows.length > 0 ? 1 : 0`
process.exitCode = 0;
