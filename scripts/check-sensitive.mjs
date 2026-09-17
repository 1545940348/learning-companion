/**
 * 提交前敏感信息检查（对应待办 P-C17，补充说明 §5.3 敏感信息纪律）
 *
 * ### 为什么需要它
 *
 * 「转 public 前手工扫一遍」这件事**做过一次就会忘第二次**。而且它有三个容易漏的地方：
 *   1. 只看工作区 → 漏掉**曾经提交过、后来删掉**的文件（它们永远留在历史里）；
 *   2. 只看被跟踪文件 → 漏掉**即将被提交**的未跟踪文件；
 *   3. 只搜 "apiKey" 字面量 → 漏掉真实密钥的形态（`sk-…`、`Bearer …`）。
 *
 * 因此本脚本扫三处：**工作区被跟踪文件 + 未被忽略的未跟踪文件 + 全部历史 blob**。
 *
 * ### 一个刻意的实现选择
 *
 * 历史扫描**不用 `git grep`**，而是 `git cat-file --batch` 取出所有 blob 在 JS 里匹配。
 * 原因：`git grep -E` 走 POSIX ERE，不支持 `(?:…)` 非捕获组、`\s` 等写法，
 * 于是历史扫描与工作区扫描**必须写两套正则** —— 两套就会漂移，
 * 而"历史扫描悄悄失效"是最危险的一种失效（它给的是虚假的安全感）。
 * 取 blob 到 JS 里扫，**只有一套规则**，且两处口径天然一致。
 *
 * ### 判定口径
 *
 * - `[失败]` = 命中硬性红线（密钥、PII、禁止入库的路径），**必须处理后再提交 / 再转 public**；
 * - `[注意]` = 需要人看一眼（例如仓库里出现个人邮箱），不阻断；
 * - 退出码非 0 表示存在 `[失败]`。
 *
 * ### 用法
 *
 *   npm run verify:sensitive
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

let passed = 0;
let failed = 0;
let warned = 0;

const ok = (label) => {
  passed += 1;
  console.log(`  [通过] ${label}`);
};
const bad = (label, detail) => {
  failed += 1;
  console.log(`  [失败] ${label}${detail ? ` —— ${detail}` : ''}`);
};
const warn = (label, detail) => {
  warned += 1;
  console.log(`  [注意] ${label}${detail ? ` —— ${detail}` : ''}`);
};

/** 运行 git 并按行返回输出；退出码 1 视为「无匹配」，不抛异常 */
function git(args, { allowEmpty = false } = {}) {
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').filter((line) => line.length > 0);
  } catch (error) {
    if (allowEmpty && error.status === 1) return [];
    throw error;
  }
}

/* ==================== 扫描规则（唯一一套，工作区与历史共用） ==================== */

/** 硬性红线：绝不应当出现在仓库里的内容 */
const SECRET_PATTERNS = [
  ['OpenAI 风格密钥', /sk-[A-Za-z0-9]{16,}/],
  ['GitHub PAT（classic）', /ghp_[A-Za-z0-9]{20,}/],
  ['GitHub PAT（fine-grained）', /github_pat_[A-Za-z0-9_]{20,}/],
  ['Bearer 令牌', /Bearer[ \t]+[A-Za-z0-9._-]{24,}/],
  ['私钥文件内容', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // 注意：赋值后只允许行内空白，**不能让 \s 跨行** ——
  // `FOO_API_KEY=`（空值）后面紧跟下一行的变量名，跨行匹配会产生假阳性
  ['被赋非空值的密钥型变量', /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)[ \t]*=[ \t]*["']?[A-Za-z0-9_\-]{12,}/],
  ['被赋非空值的 apiKey/token 字段', /["'](?:api[_-]?key|access[_-]?token|secret)["'][ \t]*:[ \t]*["'][^"']{12,}["']/],
];

/** PII：手机号与身份证号 */
const PII_PATTERNS = [
  ['中国大陆手机号', /1[3-9]\d{9}/],
  ['身份证号', /\d{17}[\dXx]/],
];

/** 需要人看一眼，但不阻断 */
const SOFT_PATTERNS = [
  ['个人邮箱域名', /[A-Za-z0-9._%+-]+@(?:qq|gmail|163|126|outlook|hotmail|foxmail)\.[A-Za-z]+/],
];

/** 绝不能进入版本控制的路径。**`.env.example` 是明确允许的**（.gitignore 里有 `!.env.example`） */
const FORBIDDEN_PATHS = [
  [/(^|\/)node_modules\//, '依赖目录'],
  [/(^|\/)dist\//, '构建产物'],
  [/(^|\/)\.npm-cache\//, '本地 npm 缓存'],
  [/(^|\/)\.learnbuddy\//, '本地工作数据'],
  [/(^|\/)\.env$/, '真实密钥文件'],
  [/(^|\/)\.env\.[^/]+$/, '真实密钥文件（变体）'],
];

/** 上述规则里允许的例外 —— key 为被检查的路径，value 为原因 */
const PATH_ALLOWLIST = new Map([['apps/server/.env.example', '范例模板，会随仓库提交且必须保持空值']]);

/** `.gitignore` 必须覆盖的条目（缺任何一个都可能误提交） */
const REQUIRED_IGNORES = ['node_modules/', 'dist/', '.npm-cache/', '.learnbuddy/', '.env', '*.log'];

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** 命中检查：返回命中的规则名数组；非文本内容返回 null 表示跳过 */
function scanText(text) {
  if (text.includes('\u0000')) return null;
  return {
    secrets: SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label),
    pii: PII_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label),
    soft: SOFT_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label),
  };
}

console.log('=== 提交前敏感信息检查 ===\n');

/* ==================== 1. 被跟踪的路径 ==================== */

console.log('--- 1. 被跟踪的路径：有没有禁止入库的目录 ---');
{
  const tracked = git(['ls-files']);
  const hits = [];
  for (const file of tracked) {
    if (PATH_ALLOWLIST.has(file)) continue;
    for (const [re, label] of FORBIDDEN_PATHS) {
      if (re.test(file)) hits.push(`${file}（${label}）`);
    }
  }
  if (hits.length === 0) {
    ok(`被跟踪文件 ${tracked.length} 个，无禁止入库路径`);
    if (PATH_ALLOWLIST.size > 0) ok(`例外名单生效：${[...PATH_ALLOWLIST.keys()].join(' / ')}`);
  } else {
    bad('存在禁止入库的被跟踪路径', hits.slice(0, 5).join(' / '));
  }
}

/* ==================== 2. .gitignore 覆盖 ==================== */

console.log('\n--- 2. .gitignore 是否覆盖关键条目 ---');
{
  const ignore = readFileSync('.gitignore', 'utf8');
  const missing = REQUIRED_IGNORES.filter((entry) => {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^${escaped}[ \\t]*$`, 'm').test(ignore);
  });
  if (missing.length === 0) ok(`关键条目已覆盖（${REQUIRED_IGNORES.join(' / ')}）`);
  else bad('`.gitignore` 缺少关键条目', missing.join(' / '));
}

/* ==================== 3. 工作区内容扫描 ==================== */

console.log('\n--- 3. 工作区内容：被跟踪文件 + 待提交的未跟踪文件 ---');
{
  const tracked = git(['ls-files']);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], { allowEmpty: true });
  const candidates = [...tracked, ...untracked];

  const secretHits = [];
  const piiHits = [];
  const softHits = [];
  let scanned = 0;
  let skipped = 0;

  for (const file of candidates) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // 已被删除但仍在索引中
    }
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) {
      skipped += 1;
      continue;
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      skipped += 1;
      continue;
    }
    const result = scanText(text);
    if (result === null) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    result.secrets.forEach((label) => secretHits.push(`${file}：${label}`));
    result.pii.forEach((label) => piiHits.push(`${file}：${label}`));
    result.soft.forEach((label) => softHits.push(`${file}：${label}`));
  }

  ok(`已扫描 ${scanned} 个文本文件（跳过二进制/超大 ${skipped} 个）`);
  if (untracked.length > 0) ok(`其中包含 ${untracked.length} 个待提交的未跟踪文件`);

  if (secretHits.length === 0) ok('工作区无密钥特征');
  else bad('工作区发现密钥特征', secretHits.slice(0, 5).join(' / '));

  if (piiHits.length === 0) ok('工作区无手机号 / 身份证号');
  else bad('工作区发现 PII', piiHits.slice(0, 5).join(' / '));

  if (softHits.length === 0) ok('工作区无个人邮箱域名');
  else warn('工作区出现个人邮箱 —— 公开仓库里等于主动公开', softHits.slice(0, 5).join(' / '));
}

/* ==================== 4. 全历史内容扫描 ==================== */

console.log('\n--- 4. 全历史：所有提交的每一个 blob（转 public 会暴露这一层）---');
{
  const objectLines = git(['rev-list', '--objects', '--all']);
  const shas = [];
  for (const line of objectLines) {
    const sha = line.split(' ')[0];
    if (/^[0-9a-f]{40}$/.test(sha)) shas.push(sha);
  }
  const unique = [...new Set(shas)];

  // git cat-file --batch：一次性读出所有对象，避免几百次子进程
  const proc = spawnSync('git', ['cat-file', '--batch'], {
    input: `${unique.join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    bad('无法读取历史对象', String(proc.stderr).slice(0, 200));
  } else {
    const buf = proc.stdout;
    const secretHits = [];
    const piiHits = [];
    const softHits = [];
    let blobs = 0;
    let skipped = 0;
    let cursor = 0;

    while (cursor < buf.length) {
      const nl = buf.indexOf(0x0a, cursor);
      if (nl === -1) break;
      const header = buf.toString('utf8', cursor, nl);
      const [, type, sizeText] = header.split(' ');
      const size = Number(sizeText);
      const start = nl + 1;
      if (!Number.isFinite(size)) break;
      const content = buf.subarray(start, start + size);
      cursor = start + size + 1; // 跳过内容后的换行

      if (type !== 'blob') continue;
      blobs += 1;
      if (size > MAX_TEXT_BYTES) {
        skipped += 1;
        continue;
      }
      const result = scanText(content.toString('utf8'));
      if (result === null) {
        skipped += 1;
        continue;
      }
      const head = header.split(' ')[0].slice(0, 8);
      result.secrets.forEach((label) => secretHits.push(`${head}：${label}`));
      result.pii.forEach((label) => piiHits.push(`${head}：${label}`));
      result.soft.forEach((label) => softHits.push(`${head}：${label}`));
    }

    ok(`已扫描 ${blobs} 个历史 blob（跳过二进制 ${skipped} 个，跨 ${git(['rev-list', '--all']).length} 个提交）`);

    if (secretHits.length === 0) ok('★ 全历史无密钥特征');
    else bad('★ 全历史发现密钥特征 —— 工作区删掉也没用，它永久留在历史里', secretHits.slice(0, 5).join(' / '));

    if (piiHits.length === 0) ok('★ 全历史无手机号 / 身份证号');
    else bad('★ 全历史发现 PII', piiHits.slice(0, 5).join(' / '));

    if (softHits.length === 0) ok('全历史无个人邮箱域名');
    else warn('全历史（含提交元数据之外的文件内容）出现个人邮箱', softHits.slice(0, 5).join(' / '));
  }
}

/* ==================== 5. 历史里的 .env 类文件 ==================== */

console.log('\n--- 5. 全历史：有没有真实 .env 被提交过 ---');
{
  const everAdded = git(['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A']);
  const unique = [...new Set(everAdded)];
  const envFiles = unique.filter((f) => /(^|\/)\.env(\..+)?$/.test(f));
  const realEnv = envFiles.filter((f) => !f.endsWith('.example'));

  ok(`历史中出现过的文件共 ${unique.length} 个`);
  if (realEnv.length === 0) {
    ok(`★ 无真实 .env 进入过历史${envFiles.length > 0 ? `（仅有 ${envFiles.join(' / ')}）` : ''}`);
  } else {
    bad('★ 真实 .env 曾进入历史 —— 即使已删除也仍在历史里', realEnv.join(' / '));
  }
}

/* ==================== 6. .env.example 只允许空值 ==================== */

console.log('\n--- 6. .env.example：评委可见，只允许空值或无害配置 ---');
{
  const file = 'apps/server/.env.example';
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    warn(`${file} 不存在，跳过`);
  }
  if (text.length > 0) {
    const assignments = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1).trim()];
      });

    const sensitive = assignments.filter(
      ([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value.length > 0,
    );
    const harmless = assignments.filter(
      ([name, value]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value.length > 0,
    );

    if (sensitive.length === 0) {
      ok(`密钥型变量全部为空值（共 ${assignments.length} 项，其中无害非空 ${harmless.length} 项：${harmless.map(([n]) => n).join(' / ')}）`);
    } else {
      bad('存在被赋值的密钥型变量', sensitive.map(([n]) => n).join(' / '));
    }
  }
}

/* ==================== 7. 本机真实密钥文件 ==================== */

console.log('\n--- 7. 本机的真实密钥文件状态 ---');
{
  const found = [];
  for (const candidate of ['apps/server/.env', '.env']) {
    try {
      statSync(candidate);
      found.push(candidate);
    } catch {
      /* 不存在，符合预期 */
    }
  }
  if (found.length === 0) ok('本机无 .env（密钥只存在于仓库之外）');
  else warn('本机存在 .env —— 确认它被 .gitignore 排除且从未入库', found.join(' / '));
}

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败${warned > 0 ? `，${warned} 项注意` : ''}`);
if (failed > 0) {
  console.log('\n⚠️ 存在失败项：**处理完再提交 / 再转 public**。历史里的内容删不掉，只能重写历史。');
  process.exitCode = 1;
}
