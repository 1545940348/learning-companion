/**
 * 第三方依赖与许可证核对（对应待办 P-C15，补充说明 §5.2「依赖说明」、赛事手册 8.2）
 *
 * ### 它防的是三类"看起来对"的错
 *
 *   1. **README 声明了但代码里没有**（或反之）—— 声明表与 package.json 各自演化后必然漂移；
 *   2. **许可证写错** —— README 表里 handwrite 的 license 与包真实 license 不一致，
 *      而赛事要求"如实声明"，写错就是失真；
 *   3. **脚本用了一个没声明的命令行工具** —— 这类错最隐蔽：**本机装了就能跑，别人 clone 下来直接失败**。
 *      本脚本第一次运行时正是靠这一条抓到了 `concurrently`（根 `npm run dev` 用了它，却从未声明）。
 *
 * ### 用法
 *
 *   npm run verify:licenses
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** 内部包不参与第三方核对 */
const isInternal = (name) => name.startsWith('@lc/');

console.log('=== 第三方依赖与许可证核对 ===\n');

const rootPkg = readJson('package.json');
const workspacePkgs = [
  { file: 'package.json', pkg: rootPkg, label: '（根）' },
  ...rootPkg.workspaces.flatMap((pattern) => {
    const [dir, sub] = pattern.split('/');
    if (sub !== '*') return [];
    return readdirSync(dir)
      .filter((name) => existsSync(join(dir, name, 'package.json')))
      .map((name) => ({
        file: `${dir}/${name}/package.json`,
        pkg: readJson(`${dir}/${name}/package.json`),
        label: `${dir}/${name}`,
      }));
  }),
];

/* ==================== 1. 声明的依赖是否都能解析到 ==================== */

console.log('--- 1. 声明的依赖是否都装得上、许可证是否读到 ---');

const declared = new Map(); // name -> { ranges:Set, workspaces:Set, kind }
for (const { pkg, label } of workspacePkgs) {
  for (const [kind, table] of [
    ['dependencies', pkg.dependencies ?? {}],
    ['devDependencies', pkg.devDependencies ?? {}],
  ]) {
    for (const [name, range] of Object.entries(table)) {
      if (isInternal(name)) continue;
      const entry = declared.get(name) ?? { ranges: new Set(), workspaces: new Set(), kinds: new Set() };
      entry.ranges.add(range);
      entry.workspaces.add(label);
      entry.kinds.add(kind);
      declared.set(name, entry);
    }
  }
}

const installed = new Map(); // name -> { version, license }
const missing = [];
for (const name of declared.keys()) {
  const path = join('node_modules', name, 'package.json');
  if (!existsSync(path)) {
    missing.push(name);
    continue;
  }
  const meta = readJson(path);
  installed.set(name, { version: meta.version, license: meta.license ?? meta.licenses ?? '???' });
}

ok(`共声明 ${declared.size} 个第三方依赖：${[...declared.keys()].sort().join(' / ')}`);
if (missing.length === 0) ok('全部可在 node_modules 解析到（无需凭据即可安装）');
else bad('有依赖未安装', missing.join(' / '));

/* ==================== 2. 各包自身必须有 license 字段 ==================== */

console.log('\n--- 2. 每个 workspace 自身声明了许可证吗 ---');
{
  const missingLicense = workspacePkgs.filter(({ pkg }) => !pkg.license).map(({ file }) => file);
  if (missingLicense.length === 0) ok(`${workspacePkgs.length} 个 package.json 均含 license 字段`);
  else bad('缺少 license 字段', missingLicense.join(' / '));
}

/* ==================== 3. README 声明表 ↔ 实际依赖 ==================== */

console.log('\n--- 3. README 依赖声明表与实际依赖是否一致 ---');

const README = 'README.md';
const readmeText = readFileSync(README, 'utf8');

/** 从 README 的「第三方依赖声明」小节里解析表格行：| `pkg` | 版本 | 用途 | 许可 | */
function parseReadmeTable() {
  const start = readmeText.indexOf('## 第三方依赖声明');
  if (start === -1) return null;
  const rest = readmeText.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const nameCell = cells[0].replace(/`/g, '').trim();
    if (!nameCell || nameCell.startsWith('---') || nameCell === '依赖') continue;
    // 一行里可能出现多个包，README 的写法是 `react` / `react-dom`（斜杠两侧有空格）。
    // ⚠️ 只能按"两侧有空格的斜杠"切 —— 按裸 `/` 切会把作用域包 `@scope/name` 切成两个。
    for (const name of nameCell.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean)) {
      rows.push({ name, version: cells[1], purpose: cells[2], license: cells[3] });
    }
  }
  return rows;
}

const readmeRows = parseReadmeTable();
if (!readmeRows) {
  bad('README 中找不到「第三方依赖声明」小节');
} else {
  ok(`README 声明表解析出 ${readmeRows.length} 条：${readmeRows.map((r) => r.name).join(' / ')}`);

  const declaredNames = new Set(declared.keys());
  const readmeNames = new Set(readmeRows.map((r) => r.name));

  const notInReadme = [...declaredNames].filter((name) => !readmeNames.has(name));
  if (notInReadme.length === 0) ok('★ 实际依赖全部在 README 中声明');
  else bad('★ 代码里用了但 README 未声明', notInReadme.join(' / '));

  const notInCode = [...readmeNames].filter((name) => !declaredNames.has(name));
  if (notInCode.length === 0) ok('★ README 中声明的依赖都真实存在');
  else warn('README 声明了但代码里没有（可能是"计划引入"）', notInCode.join(' / '));

  /* 3b. 许可证是否与包真实 license 一致 */
  const licenseMismatch = [];
  for (const row of readmeRows) {
    const real = installed.get(row.name);
    if (!real) continue;
    const readmeLicense = row.license.replace(/\*\*/g, '').trim();
    if (!real.license || real.license === '???') continue;
    if (readmeLicense.toLowerCase() !== String(real.license).toLowerCase()) {
      licenseMismatch.push(`${row.name}: README 写 ${readmeLicense}，实际 ${real.license}`);
    }
  }
  if (licenseMismatch.length === 0) ok('★ 许可证声明与实际一致（逐条比对）');
  else bad('★ 许可证声明与实际不一致', licenseMismatch.join(' / '));

  /* 3c. 版本号是否明显过期（只比 major） */
  const versionDrift = [];
  for (const row of readmeRows) {
    const real = installed.get(row.name);
    if (!real) continue;
    const readmeMajor = /\d+/.exec(row.version.replace(/[^0-9.]/g, ' ').trim());
    const realMajor = /\d+/.exec(real.version);
    if (readmeMajor && realMajor && readmeMajor[0] !== realMajor[0]) {
      versionDrift.push(`${row.name}: README ${row.version} / 实际 ${real.version}`);
    }
  }
  if (versionDrift.length === 0) ok('版本号档位与安装版本一致');
  else warn('版本号档位不一致', versionDrift.join(' / '));
}

/* ==================== 4. 脚本里用到的外部 CLI 是否已声明 ==================== */

console.log('\n--- 4. npm 脚本用到的外部命令是否都有对应依赖（本机装了 ≠ 别人能跑）---');

/** 扫描已安装的顶层包，建立 bin 名 → 包名 的映射 */
function buildBinIndex() {
  const index = new Map();
  const scan = (dir, scopePrefix = '') => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      if (scopePrefix && !statSync(full).isDirectory()) continue;
      if (name.startsWith('@')) {
        scan(full, name);
        continue;
      }
      const pkgPath = join(full, 'package.json');
      if (!existsSync(pkgPath)) continue;
      let meta;
      try {
        meta = readJson(pkgPath);
      } catch {
        continue;
      }
      const bin = meta.bin;
      const pkgName = scopePrefix ? `${scopePrefix}/${name}` : name;
      if (typeof bin === 'string') index.set(name, pkgName);
      else if (bin && typeof bin === 'object') {
        for (const binName of Object.keys(bin)) index.set(binName, pkgName);
      }
    }
  };
  scan('node_modules');
  return index;
}

const binIndex = buildBinIndex();

/** npm / node 自带的命令，不需要依赖声明 */
const BUILTIN = new Set(['npm', 'node', 'npx', 'cd', 'echo', 'rm', 'cp', 'mv', 'tsc', 'git']);

const undeclaredBins = [];
const checkedBins = new Set();
for (const { pkg, label } of workspacePkgs) {
  for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
    // 按 shell 连接符拆段，逐段看第一个可执行名
    for (const segment of command.split(/&&|\|\||;/)) {
      let tokens = segment.trim().split(/\s+/).filter(Boolean);
      // 去掉开头的 VAR=value 赋值
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
      if (tokens.length === 0) continue;
      let bin = tokens[0];
      if (bin === 'npx' || bin === 'npm-run-all') bin = tokens[1] ?? bin;
      if (bin === 'npm') continue;
      if (BUILTIN.has(bin) || bin.startsWith('-')) continue;
      // 跳过 npm script 的递归调用（npm:xxx / run xxx）
      if (bin.startsWith('npm:')) continue;
      checkedBins.add(bin);
      const provider = binIndex.get(bin);
      if (!provider) {
        undeclaredBins.push(`${label} 的 ${scriptName}：${bin}（node_modules 里找不到提供者）`);
      } else if (!declared.has(provider)) {
        undeclaredBins.push(`${label} 的 ${scriptName}：${bin} 由 ${provider} 提供，但未在任何 package.json 中声明`);
      }
    }
  }
}

ok(`检查了 ${checkedBins.size} 个脚本命令：${[...checkedBins].sort().join(' / ')}`);
if (undeclaredBins.length === 0) ok('★ 所有脚本命令都有已声明的依赖提供');
else bad('★ 存在未声明的脚本命令（本机能跑，别人 clone 会失败）', undeclaredBins.join(' ｜ '));

/* ==================== 5. 从未被引用的依赖（提示，不阻断）==================== */

console.log('\n--- 5. 声明了但似乎没用到的依赖（提示）---');
{
  const sources = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const codeFiles = sources
    .filter((f) => /\.(ts|tsx|mjs|js|json|css|html)$/.test(f) && !f.endsWith('package-lock.json'))
    /*
     * 跳过"在索引里、但工作区已不在"的文件。
     *
     * 为什么需要（2026-09-19 实测）：目录重构（`lib/` → `shared/lib/`）期间，
     * 被移走的文件仍留在索引里，`readFileSync` 直接 `ENOENT` 崩掉整个脚本 ——
     * 而"跟踪文件与工作区暂时不同步"恰恰是重构期间的**正常中间态**。
     * 检查工具在这种状态下崩掉会让人以为"重构把检查弄坏了"，
     * 实际上只是少了一层防御。（本环境删除需要 Windows 绝对路径，见技能
     * `blocked-file-writes-env`，所以旧文件与旧索引项还会并存一段时间。）
     */
    // 与下面的 `readFileSync(f, ...)` 同一套相对路径口径（脚本从仓库根运行）
    .filter((f) => existsSync(f));
  const blob = codeFiles.map((f) => readFileSync(f, 'utf8')).join('\n') + readmeText;

  const unused = [];
  for (const name of declared.keys()) {
    if (/^(vite|typescript)$/.test(name)) continue; // 通过配置文件/CLI 使用，不一定在源码里 import
    const bare = name.startsWith('@') ? name : name.split('/')[0];
    const needle = new RegExp(`(from\\s+['"]${bare}|require\\(['"]${bare}|['"]${bare}['"]|"${name}"|'${name}')`);
    if (!needle.test(blob)) unused.push(name);
  }
  if (unused.length === 0) ok('未发现"声明了但完全没出现"的依赖');
  else warn('以下依赖在源码/配置/README 中都没出现（确认是否还需要）', unused.join(' / '));
}

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败${warned > 0 ? `，${warned} 项注意` : ''}`);
if (failed > 0) process.exitCode = 1;
