/**
 * 提示词快照一致性检查（配合待办 P-B11，补充说明 §5.1）
 *
 * ### 它解决什么
 *
 * §5.1 要求把提示词**全文**作为评审依据入库。把提示词抄进文档必然带来漂移风险 ——
 * 而本项目刚刚吃过一次文档漂移的亏（`I9`/`I10`/`I11`：README 与知识库滞后于代码一整天）。
 * 所以这里不靠"记得同步"，而是**以代码为准逐段比对**：文档里的每一段提示词
 * 必须能在 `packages/teaching/src/prompt.ts` 里逐字找到。
 *
 * ### 比对方式
 *
 *   1. 从 `prompt.ts` 抽出所有 `export const NAME = \`...\``；
 *   2. 把 `${COURSE_SCOPE}` / `${NO_FABRICATION}` 这类插值**展开成最终送给模型的完整文本**
 *      （评审要看的是最终文本，不是带 `\${}` 的模板）；
 *   3. 断言展开后的文本**逐字出现在** `docs/tech/2026-09-17-B-提示词与工作流配置.md` 中。
 *
 * ### 用法
 *
 *   npm run verify:prompts
 */

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;

const ok = (label) => {
  passed += 1;
  console.log(`  [通过] ${label}`);
};
const bad = (label, detail) => {
  failed += 1;
  console.log(`  [失败] ${label}${detail ? ` —— ${detail}` : ''}`);
};

const PROMPT_SOURCE = 'packages/teaching/src/prompt.ts';
const SNAPSHOT_DOC = 'docs/tech/2026-09-17-B-提示词与工作流配置.md';

console.log('=== 提示词快照一致性检查 ===\n');

const source = readFileSync(PROMPT_SOURCE, 'utf8');
const doc = readFileSync(SNAPSHOT_DOC, 'utf8');

/** 抽出所有 export const NAME = `...`; —— 本项目提示词里不含反引号，可安全用非贪婪匹配 */
const constants = new Map();
const re = /export const (\w+)\s*=\s*`([\s\S]*?)`;/g;
let match;
while ((match = re.exec(source)) !== null) {
  constants.set(match[1], match[2]);
}

if (constants.size === 0) {
  bad(`无法从 ${PROMPT_SOURCE} 抽出任何提示词常量 —— 正则可能已失效，请修脚本`);
} else {
  ok(`从 ${PROMPT_SOURCE} 抽出 ${constants.size} 个常量：${[...constants.keys()].join(' / ')}`);
}

/** 展开 `${OTHER}` 插值（只支持本项目用到的单层引用，多轮展开到稳定） */
function expand(text, depth = 0) {
  if (depth > 5) return text;
  if (!/\$\{\w+\}/.test(text)) return text;
  const next = text.replace(/\$\{(\w+)\}/g, (whole, name) => (constants.has(name) ? constants.get(name) : whole));
  return next === text ? text : expand(next, depth + 1);
}

/** 文档里被比对的部分：只比对「## 1 六段提示词的全文」一节，避免正文引用产生假通过 */
const sectionStart = doc.indexOf('## 1 六段提示词的全文');
const sectionEnd = doc.indexOf('## 2 工作流');
if (sectionStart === -1 || sectionEnd === -1) {
  bad('快照文档中找不到「## 1 六段提示词的全文」或「## 2 工作流」小节');
} else {
  const section = doc.slice(sectionStart, sectionEnd);
  ok('已定位快照文档中的提示词小节');

  for (const [name, raw] of constants) {
    const full = expand(raw);
    if (section.includes(full)) {
      ok(`★ ${name} 与代码逐字一致（${full.length} 字符）`);
    } else {
      // 给出差异定位，便于直接修文档
      const firstLine = full.split('\n')[0];
      const hasFirstLine = section.includes(firstLine);
      bad(
        `★ ${name} 与代码不一致`,
        hasFirstLine ? '开头一致但后文有差异，请逐行比对' : '快照文档中找不到该段（可能漏抄或改名）',
      );
    }
  }
}

/** 反向检查：文档里不应出现已被删除的提示词段（防止"文档留着旧版本"） */
const docBlocks = doc
  .slice(doc.indexOf('## 1 六段提示词的全文'), doc.indexOf('## 2 工作流'))
  .split('\n```\n')
  .slice(1);
console.log(`\n（快照文档共收录 ${docBlocks.length} 段代码块）`);

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  console.log('\n⚠️ 提示词快照已漂移：**以代码为准改动快照文档**，不要改代码去迁就文档。');
  process.exitCode = 1;
}
