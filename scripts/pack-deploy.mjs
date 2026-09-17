/**
 * 打包出「可直接上传到云托管」的干净目录
 *
 * ### 为什么需要这个脚本
 *
 * 云托管控制台的「上传代码包 → 文件夹」要你**选一个目录**。
 * 手工挑目录很容易把不该传的东西一起传上去：
 * - `node_modules`（7000+ 文件，巨大且没必要 —— 容器里会重新装）
 * - `.env`（**本地密钥**，传上去就是泄露）
 *
 * 有脚本就不用靠人小心。它做完还会**自己扫描一遍**并打印判定。
 *
 * ### 用法（在仓库根目录）
 *
 * ```bash
 * npm run pack:deploy
 * ```
 *
 * 产出：`deploy-dist/` —— 在云托管控制台直接选这个目录。
 *
 * ### 两个实现细节（踩过的坑）
 *
 * 1. **不用 `fs.cp` 整树拷贝**：输出目录在仓库内部，Node 会拒绝
 *    「把目录拷进自己的子目录」（`ERR_FS_CP_EINVAL`），因此改为自己递归拷贝；
 * 2. **产物里写入一个自忽略的 `.gitignore`**：这样无需修改仓库的 `.gitignore`
 *    也能让 `deploy-dist/` 不出现在 `git status` 里。
 *
 * 本脚本只读仓库、只写 `deploy-dist/`，**不修改任何源码**。
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(repoRoot, 'deploy-dist');

/** 整棵子树都不打包的目录名 */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.learnbuddy',
  '.tmp',
  'deploy-dist',
  'npm-cache',
  'dist',
  '.vscode',
  '.idea',
]);

/** 绝不打包的文件名（本地密钥与本地配置） */
const EXCLUDE_FILES = new Set(['.env', '.env.local', '.env.development', '.env.production']);

/** 只按文件名判断，**不读内容** —— 密钥内容不应进入任何输出 */
const FORBIDDEN_NAMES = new Set(['.env', '.env.local']);

function relativeParts(from) {
  const rel = relative(repoRoot, from);
  if (rel === '') return [];
  return rel.split(sep).filter((part) => part.length > 0);
}

/** 是否拷贝该路径（目录返回 false 则整棵子树跳过） */
function shouldCopy(src) {
  const parts = relativeParts(src);
  if (parts.length === 0) return true;
  if (parts.some((part) => EXCLUDE_DIRS.has(part))) return false;
  return !EXCLUDE_FILES.has(parts[parts.length - 1]);
}

/**
 * 递归拷贝。单个文件失败不中断整体（打印警告后继续），
 * 避免因为一个被占用的文件导致整包失败。
 */
async function copyTree(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });

  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (error) {
    console.warn(`  ⚠️ 跳过无法读取的目录：${srcDir}（${error?.code ?? error}）`);
    return;
  }

  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    if (!shouldCopy(src)) continue;

    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
      continue;
    }
    if (!entry.isFile()) continue; // 符号链接等一律跳过，避免把外部内容带进来

    try {
      await copyFile(src, dest);
    } catch (error) {
      console.warn(`  ⚠️ 跳过无法复制的文件：${relative(repoRoot, src)}（${error?.code ?? error}）`);
    }
  }
}

/**
 * 准备输出目录。
 *
 * ⚠️ 删除可能被环境拦截：某些桌面环境会把删除重定向到回收站，
 * 回收站操作失败时会抛错（即使目录其实已经删掉了）。因此这里：
 * - 删除抛错但目录**已不存在** → 视为成功；
 * - 删除抛错且目录**仍在** → 降级为就地覆盖，并明确提醒可能有上一轮残留。
 */
async function prepareOutDir(dir) {
  if (existsSync(dir)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(dir)) {
        console.warn(`  ⚠️ 旧产物目录未能删除（${error?.code ?? error}），将就地覆盖。`);
        console.warn('     建议手动删除 deploy-dist 后再跑一次，避免上一轮的残留文件被打包。');
        await mkdir(dir, { recursive: true });
        return;
      }
      console.warn('  ℹ️ 删除时报错，但目录已不存在，按成功处理。');
    }
  }
  await mkdir(dir, { recursive: true });
}

/** 递归扫描产物，找出不该出现的东西 */
async function scan(dir) {
  const problems = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(outDir, full);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          problems.push(`不该出现目录：${rel}`);
          continue; // 不再深入，避免列出几千条
        }
        await walk(full);
        continue;
      }

      if (FORBIDDEN_NAMES.has(entry.name)) {
        problems.push(`不该出现文件：${rel}`);
      }

      const info = await stat(full);
      fileCount += 1;
      totalBytes += info.size;
    }
  }

  await walk(dir);
  return { problems, fileCount, totalBytes };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

console.log('=== 打包「可直接上传到云托管」的目录 ===\n');

if (!existsSync(join(repoRoot, 'package.json'))) {
  console.error(`✗ 找不到 package.json，请在仓库根目录运行。当前解析到：${repoRoot}`);
  process.exit(1);
}

console.log(`仓库根目录：${repoRoot}`);
console.log(`输出目录　：${outDir}\n`);

await prepareOutDir(outDir);
await copyTree(repoRoot, outDir);

// 自忽略：不必改仓库的 .gitignore，也不会让 deploy-dist 出现在 git status 里
await writeFile(
  join(outDir, '.gitignore'),
  '# 本目录是 pack:deploy 生成的待上传产物，不进版本库\n*\n',
  'utf8',
);

const { problems, fileCount, totalBytes } = await scan(outDir);

console.log('清理完成。');
console.log(`  文件数：${fileCount}`);
console.log(`  总体积：${formatSize(totalBytes)}`);

console.log('\n--- 安全检查 ---');
if (problems.length === 0) {
  console.log('  ✅ 未发现 node_modules / .git / .env —— 可以上传');
} else {
  console.log(`  ❌ 发现 ${problems.length} 处不该打包的内容：`);
  for (const problem of problems.slice(0, 20)) {
    console.log(`     · ${problem}`);
  }
  if (problems.length > 20) {
    console.log(`     …… 另有 ${problems.length - 20} 处`);
  }
}

console.log('\n--- 下一步 ---');
console.log('  云托管控制台：通过本地代码部署 → 上传代码包 → 类型选「文件夹」');
console.log(`  选择目录：${outDir}`);
console.log('  端口填：3000');

if (problems.length > 0) {
  console.log('\n⚠️ 有不该打包的内容，请先修正后再上传。');
  process.exitCode = 1;
}
