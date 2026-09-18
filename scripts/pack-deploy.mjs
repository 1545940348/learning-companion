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
 * 5. **自检与拷贝必须同源**：自检原先只查 `node_modules`/`.git`/`.env` 三个名字，
 *    只能证明"没踩到上一轮踩过的坑"。现在拷贝判定（`shouldCopy`）与自检（`scan`）
 *    **共用同一个 `isForbiddenFile()`**，并且它覆盖 `.gitignore` 的密钥规则全集
 *    （`.env` / `.env.*` / `*.pem` / `*.key` / `*.p12` / `secrets.json`，
 *    例外 `.env.example`）—— 手抄的子集会让 `.env.bak`、`secrets.json`
 *    这类文件被拷进包而自检仍打印 ✅。
 * 6. **输出目录要先验身份**（2026-09-18 补，见 `assertUsableOutDir`）：
 *    `PACK_DEPLOY_OUT` 是唯一由用户提供的路径，而它既可能等于仓库本身
 *    （会先 `rm -rf` 整个仓库），也可能在仓库内部导致 `copyTree` 无限自嵌套。
 *
 * 本脚本只读仓库、只写输出目录，**不修改任何源码**。
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
 * ⚠️ 输出目录的**身份校验**（2026-09-18 补）。
 *
 * 本脚本有体积闸门、有自检，却对**唯一由用户提供的那个路径**（`PACK_DEPLOY_OUT`）
 * 没有任何校验。两种后果都是灾难性的：
 *
 * 1. **输出目录 = 仓库本身（或它的上级）**：`prepareOutDir()` 会先对仓库执行
 *    `rm(dir, { recursive: true, force: true })` —— `PACK_DEPLOY_OUT=D:\...\LearnBuddy`
 *    等于一条删库命令，而它看起来只是"把产物放到别处"。
 * 2. **输出目录在仓库内部、名字又不在 `EXCLUDE_DIRS` 里**：`copyTree()` 先建目标目录
 *    再 `readdir` 源目录，于是每一层都能看见自己并继续下钻 —— 会一直拷到路径长度
 *    上限才报错（上一轮两次复现：819 层嵌套 / 473 MB），清理那棵树本身也很痛苦。
 *    （默认的 `deploy-dist/` 在排除名单里，所以默认用法是安全的。）
 *
 * 判定必须发生在**任何删除动作之前**，并且宁可拒跑也不"尽力而为"。
 *
 * ⚠️ **不能复用 `EXCLUDE_DIRS` 当"可安全删除"的名单**（2026-09-18 复审补）：
 * 那是"不打进包里"的名单，而里面恰好有 `.git` 与 `.learnbuddy` —— 它们不打进包
 * 是对的，但更**不能被删**。混用会出现 `PACK_DEPLOY_OUT=<仓库>/.git` 先通过校验、
 * 随后被 `prepareOutDir()` 整个 `rm -rf`（等于删掉全部提交历史）。
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  /*
   * `rel !== '..'` 与 `'..' + sep` 两处都要判。
   * 原写法 `!rel.startsWith('..')` 会把**名字以 `..` 开头的目录**（如 `..cache`）
   * 判成"仓库之外的路径"，于是下面两个分支一起跳过、校验形同不存在，自嵌套复现。
   */
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * 仓库内**绝不能作为输出目录被删除**的首层目录名。
 *
 * 与 `EXCLUDE_DIRS` 是两件事：`EXCLUDE_DIRS` 回答"要不要打进包里"，
 * 这里回答"删了会不会毁掉不可再生的东西"。`.git` = 全部提交历史，
 * `.learnbuddy` = 本地记忆与 trash。
 */
const NEVER_DELETE_DIRS = new Set(['.git', '.learnbuddy', 'node_modules']);

function assertUsableOutDir(dir) {
  const repoInsideOut = isInside(dir, repoRoot);
  const insideRepo = isInside(repoRoot, dir);
  const topSegment = relative(repoRoot, dir).split(sep)[0] ?? '';

  if (dir === repoRoot || repoInsideOut) {
    console.error('✗ 输出目录不合法：它等于仓库根目录，或是仓库的上级目录。');
    console.error(`  仓库根　：${repoRoot}`);
    console.error(`  输出目录：${dir}`);
    console.error('  继续执行会先对整个仓库递归删除，再把它拷进它自己。已中止，未删除任何东西。');
    console.error('  请把 PACK_DEPLOY_OUT 指到仓库之外的目录，或去掉它使用默认的 deploy-dist/。');
    process.exit(1);
  }

  if (insideRepo && NEVER_DELETE_DIRS.has(topSegment)) {
    console.error(`✗ 输出目录不合法：它指向仓库内的「${topSegment}」，这个目录不允许被删除。`);
    console.error(`  输出目录：${dir}`);
    console.error('  `prepareOutDir()` 会先递归删除该目录。已中止，未删除任何东西。');
    console.error('  请改用仓库之外的目录，或去掉 PACK_DEPLOY_OUT 使用默认的 deploy-dist/。');
    process.exit(1);
  }

  // 最后一道保险：目标目录里已经有 `.git` 就不删 —— 覆盖"同一目录的别名"
  // （软链 / junction / 8.3 短名）这类字符串比较识别不出来的情况。
  if (existsSync(join(dir, '.git'))) {
    console.error(`✗ 输出目录不合法：${dir} 里有 .git，它看起来是某个版本库的根。已中止，未删除任何东西。`);
    process.exit(1);
  }

  if (insideRepo && !EXCLUDE_DIRS.has(topSegment)) {
    console.error(`✗ 输出目录不合法：它在仓库内部，且首层名字「${topSegment}」不在排除名单里。`);
    console.error(`  输出目录：${dir}`);
    console.error('  继续执行会把输出目录拷进它自己（无限嵌套，直到路径超长才报错）。已中止。');
    console.error('  请改用仓库之外的目录，或去掉 PACK_DEPLOY_OUT 使用默认的 deploy-dist/。');
    process.exit(1);
  }
}

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

/** 本地日志等按后缀排除（`.gitignore` 里对应 `*.log`） */
const EXCLUDE_SUFFIXES = ['.log'];

/**
 * 绝不打包的文件名规则 —— **与 `.gitignore` 的密钥规则同源**（2026-09-18 修正）。
 *
 * 原实现是两份**手抄的子集**：`EXCLUDE_FILES` 只列了四个精确名字，
 * 自检用的 `FORBIDDEN_NAMES` 更只认 `.env` / `.env.local`。于是
 * `apps/server/.env.bak`（被 `.gitignore` 的 `.env.*` 覆盖，所以 `git status` 是干净的）、
 * 仓库根的 `secrets.json`、`service-key.pem` 会被照拷进上传包，
 * 而末尾自检**仍然打印 ✅** —— 操作者接着就把它传上云托管。
 *
 * 现在全脚本只有**一处**规则：`shouldCopy()`（决定拷不拷）与 `scan()`（自检报不报）
 * 都调用 `isForbiddenFile()`。自检与排除名单同源，才谈得上"自检通过"。
 *
 * ⚠️ 本脚本按文件系统遍历、**不读 `.gitignore`**，所以这些规则必须自己再写一遍；
 * 以后 `.gitignore` 新增密钥规则，这里要同步新增。
 */
const SECRET_NAME_PATTERNS = [
  /^\.env$/i, // .env
  /^\.env\..+$/i, // .env.local / .env.bak / .env.production …（.env.example 见下方例外）
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /^secrets\.json$/i,
];

/** `.gitignore` 里明确放行的例外（`!.env.example`）—— 它本来就该随包交付 */
const ALLOWED_NAMES = new Set(['.env.example']);

/**
 * 该文件名是否"绝不打包"（密钥或本地日志）。
 *
 * **唯一判据来源**，`shouldCopy()` 与 `scan()` 共用 —— 两边分叉正是上一轮
 * "拷进去了却自检 ✅"的根因。
 */
function isForbiddenFile(name) {
  const lower = name.toLowerCase();
  if (ALLOWED_NAMES.has(lower)) return false;
  if (SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))) return true;
  return EXCLUDE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

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
  return !isForbiddenFile(parts[parts.length - 1]);
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

      if (isForbiddenFile(entry.name)) {
        problems.push(`不该出现文件（密钥或本地日志）：${rel}`);
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

// 必须在 prepareOutDir（含递归删除）之前拒掉危险路径
assertUsableOutDir(outDir);

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
  console.log(
    `  ✅ 未发现排除名单里的任何目录、密钥/日志文件（与拷贝时的判定同源），` +
      `体积也在 ${formatSize(MAX_PACK_BYTES)} 以内 —— 可以上传`,
  );
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
