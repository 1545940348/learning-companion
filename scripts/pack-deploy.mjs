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
 * ### 几个实现细节（踩过的坑）
 *
 * 1. **不用 `fs.cp` 整树拷贝**：输出目录在仓库内部，Node 会拒绝
 *    「把目录拷进自己的子目录」（`ERR_FS_CP_EINVAL`），因此改为自己递归拷贝；
 * 2. **产物里写入一个自忽略的 `.gitignore`**：这样无需修改仓库的 `.gitignore`
 *    也能让 `deploy-dist/` 不出现在 `git status` 里；
 * 3. **排除名单要照抄"点名开头的目录"**：本机 npm 缓存叫 `.npm-cache`，
 *    名字里那个点写漏了，判定就整个失效（2026-09-18 修正，见 `EXCLUDE_DIRS` 注释）；
 * 4. **本脚本按文件系统遍历，不读 `.gitignore`** —— 所以 `.gitignore` 里的
 *    `*.log`、`.npm-cache/` 这些规则，这里必须**自己再写一遍**；
 * 5. **自检要与排除名单同源**：只查 `node_modules`/`.git`/`.env` 三个名字，
 *    只能证明"没踩到上一轮踩过的坑"，不能证明产物干净 —— 现已改为
 *    "名单里的任何目录 + 禁止后缀 + 体积上限"三道判定。
 *
 * 本脚本只读仓库、只写输出目录，**不修改任何源码**。
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 输出目录。
 *
 * 默认 `deploy-dist/`（仓库根）；可用 `PACK_DEPLOY_OUT` 指到别处 ——
 * 这样在仓库之外就能**真跑一遍**打包来验证排除规则，不必先产出几百 MB 再清理。
 */
const outDir = process.env.PACK_DEPLOY_OUT
  ? resolve(process.env.PACK_DEPLOY_OUT)
  : resolve(repoRoot, 'deploy-dist');

/**
 * 整棵子树都不打包的目录名。
 *
 * ⚠️ **点开头的目录也要照抄**（2026-09-18 修正）：本机 npm 缓存目录叫
 * **`.npm-cache`**（见 `.gitignore`），而这里原先只写了 `npm-cache` ——
 * 名字差一个点，判定就完全失效，实测会把 **1254 个文件 / 366 MB** 的缓存打进上传包，
 * 而末尾的自检仍会打印 ✅。两个名字都留着，避免再被平台差异绊一次。
 */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.npm-cache',
  'npm-cache',
  '.git',
  '.learnbuddy',
  '.tmp',
  '.tmp_extract',
  'deploy-dist',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  'logs',
  '.vscode',
  '.idea',
]);

/** 绝不打包的文件名（本地密钥与本地配置） */
const EXCLUDE_FILES = new Set(['.env', '.env.local', '.env.development', '.env.production']);

/**
 * 绝不打包的后缀。
 *
 * `.gitignore` 里有 `*.log`，但本脚本是**按文件系统**遍历的，不读 `.gitignore` ——
 * 所以必须自己列一遍，否则本地那些 `_xxx.log` 会整包带走。
 */
const EXCLUDE_SUFFIXES = ['.log'];

/** 只按文件名判断，**不读内容** —— 密钥内容不应进入任何输出 */
const FORBIDDEN_NAMES = new Set(['.env', '.env.local']);

function relativeParts(from) {
  const rel = relative(repoRoot, from);
  if (rel === '') return [];
  return rel.split(sep).filter((part) => part.length > 0);
}

/** 是否拷贝该路径（目录返回 false 则整棵子树跳过） */
function shouldCopy(src) {
  // ① 输出目录自身及其内部一律不拷。
  //    必须按**真实路径**判断，不能只按目录名 —— 否则一旦用 PACK_DEPLOY_OUT
  //    指到自定义目录（如 deploy-dist-v2），固定名字 `deploy-dist` 就匹配不上，
  //    脚本会把产物**拷进产物里**并递归下去（2026-09-18 实测踩到，产生 10 万个文件）。
  const abs = resolve(src);
  if (abs === outDir || abs.startsWith(outDir + sep)) return false;

  const parts = relativeParts(src);
  if (parts.length === 0) return true;

  // ② 本脚本历次生成的产物目录（deploy-dist、deploy-dist-v2 …）同样不该被打进新产物
  if (parts.some((part) => part.startsWith('deploy-dist'))) return false;

  if (parts.some((part) => EXCLUDE_DIRS.has(part))) return false;
  const name = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(name)) return false;
  return !EXCLUDE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
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
  const byExtension = new Map();
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(outDir, full);

      if (entry.isDirectory()) {
        /*
         * 判据是"**排除名单里的任何一个目录名**出现了"，不只是 node_modules/.git。
         *
         * 原实现只查那两个名字，于是 `.npm-cache`（366 MB）能大摇大摆地进包，
         * 而自检仍然打印"✅ 未发现 node_modules / .git / .env" —— 它只证明
         * "没踩到上一轮踩过的坑"，不证明产物是干净的。自检的口径必须与排除名单同源。
         */
        if (EXCLUDE_DIRS.has(entry.name)) {
          problems.push(`不该出现目录：${rel}`);
          continue; // 不再深入，避免列出几千条
        }
        await walk(full);
        continue;
      }

      if (FORBIDDEN_NAMES.has(entry.name)) {
        problems.push(`不该出现文件：${rel}`);
      }
      if (EXCLUDE_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
        problems.push(`不该出现文件（本地日志）：${rel}`);
      }

      const dot = entry.name.lastIndexOf('.');
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : '(无扩展名)';
      byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1);

      const info = await stat(full);
      fileCount += 1;
      totalBytes += info.size;
    }
  }

  await walk(dir);
  return { problems, fileCount, totalBytes, byExtension };
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

const { problems, fileCount, totalBytes, byExtension } = await scan(outDir);

/*
 * 体积闸门：**这是这次补上的第二道自检**。
 *
 * 只查几个文件名是不够的 —— `.npm-cache` 这类"名字没在名单里的大目录"
 * 能让产物从 2.6 MB 涨到 368 MB，而按名字查一条都不会命中。
 * 一个正常的代码包只有几 MB；超过 `MAX_PACK_BYTES` 一定是把不该带的带上了。
 */
const MAX_PACK_BYTES = 10 * 1024 * 1024;
if (totalBytes > MAX_PACK_BYTES) {
  problems.push(
    `体积异常：${formatSize(totalBytes)} 超过 ${formatSize(MAX_PACK_BYTES)} 上限` +
      '（通常是缓存目录或构建产物被打进来了，检查 EXCLUDE_DIRS）',
  );
}

console.log('清理完成。');
console.log(`  文件数：${fileCount}`);
console.log(`  总体积：${formatSize(totalBytes)}`);
console.log('\n--- 体积构成（按扩展名，取前 8）---');
for (const [ext, count] of [...byExtension.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(4)} 个  ${ext}`);
}

console.log('\n--- 安全检查 ---');
if (problems.length === 0) {
  console.log(`  ✅ 未发现 node_modules / .git / .env / 缓存目录 / *.log，体积也在 ${formatSize(MAX_PACK_BYTES)} 以内 —— 可以上传`);
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
