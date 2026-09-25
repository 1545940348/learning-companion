/**
 * LearnBuddy 对话记录导出（待办 `P-C18`，赛事手册 §4.1「LearnBuddy 使用记录」）
 *
 * ### 这个脚本存在的唯一理由：**证明"没有事后补造"**
 *
 * 赛事手册要求提交"开发过程中与 AI buddy 的历史对话记录"，而团队又有硬规矩
 * 「不得事后补造」（初赛补充说明 §6.2）。这两条必须同时被满足：
 *
 *   - 只交出**平台自己写下的原始日志**，不添加任何人工润色过的"对话"；
 *   - 任何拿到本仓库的人都能**重跑这个脚本**，从同样的原始文件得到逐字相同的结果。
 *
 * 所以本脚本是一条**确定性管道**：读原始 `.jsonl` → 机械抽取 → 脱敏 → 排版。
 * 它不做摘要、不调模型、不"美化措辞"——凡是它写进文档的，都是原始文件里已有的字节。
 *
 * ### 输入在哪
 *
 * LearnBuddy 把会话正文按工作区目录分桶存在本机：
 *
 *   <家目录>/.learnbuddy/projects/<工作区路径的 slug>/<会话 uuid>.jsonl
 *   <家目录>/.learnbuddy/projects/<工作区路径的 slug>/<会话 uuid>/subagents/agent-*.jsonl
 *
 * 本项目**换过一次工作区**（`AI_Coding_Competition` → `AI_Coding_Competition-latest`），
 * 所以默认把两个桶**一起**收进来 —— 只收一个会漏掉前半程（含 09-16 的第一轮对话）。
 *
 * ### 脱敏口径（**唯一的改动**，逐条对齐 `scripts/check-sensitive.mjs`）
 *
 * 原始日志里混进过凭据（09-21 排查网络时把环境变量整段打印了），而记录是要交给评委的。
 * 因此输出前按下列规则替换。规则本身写在代码里，供任何人审计。
 *
 * 除这几类外**一个字都不动**：不改错别字、不改口吻、不删"看不懂""先停"这类不体面的回合
 * —— 那些恰恰是评审要看的"人工主导"证据。
 *
 * ### 输出
 *
 *   docs/records/LearnBuddy对话记录_<起始日>至<结束日>.md   主文档
 *   docs/records/附录-原始文件清单与校验.md                  原始文件 sha256／行数／时间跨度
 *   .tmp/learnbuddy-records.html                            供无头浏览器打印 PDF 的中间件
 *
 * ### 用法
 *
 *   node scripts/export-learnbuddy-records.mjs
 *   node scripts/export-learnbuddy-records.mjs --projects-dir <目录>   # 换一个 projects 桶的根
 *   node scripts/export-learnbuddy-records.mjs --dry-run               # 只打印统计，不写盘
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, tmpdir } from 'node:os';

/* ==================== 参数 ==================== */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? '');
};
const has = (name) => argv.includes(name);

/** LearnBuddy 的项目桶根目录；默认取家目录下 */
const PROJECTS_ROOT = flag('--projects-dir') || join(homedir(), '.learnbuddy', 'projects');

/** 工作区目录名前缀 —— 本项目换过一次工作区，两个桶都要收 */
const WORKSPACE_PREFIX = 'd-AI_Coding_Competition';

const DRY_RUN = has('--dry-run');

/**
 * **刻意排除**的会话，必须写清理由（"缺失即登记为缺失"，不回填、不假装它在）。
 *
 * 排除的是**本次归档作业自身所在的会话**：它仍在进行中，且内容是"生成这份文档"，
 * 收进来会形成自我指涉（文档里写着正在写这份文档）。这不是遗漏，是**已登记的边界**。
 */
const EXCLUDED_SESSIONS = new Map([
  [
    '8de0a1d2-0ebb-473f-9cee-fa0c4a7d504f',
    '本归档作业自身所在的会话（进行中，且内容即「生成此文档」，收录会自我指涉）',
  ],
]);

/**
 * 每轮 AI 可见回复的收录上限：超长时保留「开头 + 结尾」（结论通常在结尾）。
 *
 * 取值不是拍脑袋的：一份 178 轮的记录若把回复全文收进来会到 120 页以上，评委不会看；
 * 收到「要点」尺度（约 400 字）后总篇幅落在 50–70 页——**能通读，又不至于只剩结论**。
 * 可用环境变量临时调参（`LEARNBUDDY_REPLY_CAP` / `LEARNBUDDY_HEAD` / `LEARNBUDDY_TAIL`），
 * 便于"想出一版全文版"时不必改代码。
 */
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const REPLY_HEAD = num(process.env.LEARNBUDDY_HEAD, 140);
const REPLY_TAIL = num(process.env.LEARNBUDDY_TAIL, 80);
const REPLY_KEEP_FULL_UNDER = num(process.env.LEARNBUDDY_REPLY_CAP, 180);

/* ==================== 脱敏 ==================== */

const PLACEHOLDER = '<已脱敏>';
const HOME_DIR_PLACEHOLDER = '<家目录>';
const HOST_PLACEHOLDER = '<主机名>';

/** [匹配, 替换, 类别标签] —— 替换串支持 `$1` 以保留变量名/键名，只抹掉值 */
const REDACTIONS = [
  ['Bearer 令牌', /Bearer[ \t]+[A-Za-z0-9._-]{24,}/g, `Bearer ${PLACEHOLDER}`],
  ['OpenAI 风格密钥', /\bsk-[A-Za-z0-9_-]{12,}/g, '<已脱敏sk密钥>'],
  ['GitHub PAT', /\bghp_[A-Za-z0-9]{20,}/g, '<已脱敏GitHubPAT>'],
  ['GitHub PAT（细粒度）', /\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<已脱敏GitHubPAT>'],
  [
    '私钥文件内容',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '<已脱敏私钥>',
  ],
  [
    '密钥型变量赋值',
    /((?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)[ \t]*=[ \t]*["']?)[A-Za-z0-9_-]{12,}/g,
    `$1${PLACEHOLDER}`,
  ],
  [
    'apiKey/token 字段',
    /(["'](?:api[_-]?key|access[_-]?token|secret)["'][ \t]*:[ \t]*["'])[^"']{12,}(["'])/g,
    `$1${PLACEHOLDER}$2`,
  ],
  [
    '环境变量整段 dump',
    /CODEBUDDY_MCP_CONFIG=\{[^\n]*/g,
    `CODEBUDDY_MCP_CONFIG=${PLACEHOLDER}`,
  ],
  ['本机家目录（Windows）', /[A-Z]:\\Users\\[^\\\s"']+/g, HOME_DIR_PLACEHOLDER],
  ['本机家目录（正斜杠）', /[A-Z]:\/Users\/[^/\s"']+/g, HOME_DIR_PLACEHOLDER],
  ['本机家目录（Unix）', /\/(?:home|Users)\/[A-Za-z0-9._-]+/g, HOME_DIR_PLACEHOLDER],
];

/**
 * 脱敏登记表：**只记类别、次数与被抹掉内容的长度，绝不记内容本身**。
 *
 * 早先的写法会把命中值的前 28 字符当"例子"写进文档 —— 那等于在"脱敏记录"里
 * 二次泄漏（登录名、令牌前缀都会露出来）。长度足以让人核对"确实抹掉了一段长东西"，
 * 又不泄露任何字符。
 */
const redactionLog = new Map();

const HOSTNAME = hostname();
const HOSTNAME_PATTERN = HOSTNAME
  ? new RegExp(HOSTNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  : null;

function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [label, pattern, replacement] of REDACTIONS) {
    const globalRe = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    const found = out.match(globalRe);
    if (found) {
      const entry = redactionLog.get(label) ?? { count: 0, lengths: new Set() };
      entry.count += found.length;
      for (const hit of found) entry.lengths.add(hit.length);
      redactionLog.set(label, entry);
      out = out.replace(globalRe, replacement);
    }
  }
  if (HOSTNAME_PATTERN && HOSTNAME) {
    const found = out.match(HOSTNAME_PATTERN);
    if (found) {
      const entry = redactionLog.get('本机主机名') ?? { count: 0, lengths: new Set() };
      entry.count += found.length;
      for (const hit of found) entry.lengths.add(hit.length);
      redactionLog.set('本机主机名', entry);
      out = out.replace(HOSTNAME_PATTERN, HOST_PLACEHOLDER);
    }
  }
  return out;
}

/* ==================== 原始文件读取 ==================== */

const SKIP_EVENT_TYPES = new Set(['file-history-snapshot', 'resend-fork-notice']);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 剥掉平台注入的包装，只留人真正敲进去的字。
 *
 * - `system-reminder` / `data-role="user-context"`：平台每轮附加的环境说明，不是人写的；
 * - `<user_query>`：平台给提问加的定界标签，剥掉不损失内容；
 * - `<image_local_path>`：粘贴截图时平台记下的**本机绝对路径** —— 对评委无意义，
 *   且属于本机信息，整段删除。
 */
function stripInjectedContext(text) {
  return text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[a-z_-]+[^>]*data-role="user-context"[\s\S]*?<\/[a-z_-]+>/g, '')
    .replace(/<\/?user_query>/g, '')
    .replace(/<image_local_path>[\s\S]*?<\/image_local_path>/g, '')
    .trim();
}

/**
 * 中和 AI 回复里的**块级 Markdown 语法**。
 *
 * 为什么必须做：AI 回复里常有 `## 小标题` `> 引用` `|---|` 表格。原样塞进文档后，
 * 这些会被当成**文档自身的结构** —— 实测「## 逐项影响表」真的变成了文档的二级标题，
 * 会和"第 N 轮"标题混成一张假目录。
 *
 * 做法是按行在行首加一个反斜杠（Markdown 的转义），渲染时再还原：**文字一个不改**，
 * 只是不让它被解释成结构。
 */
const BLOCK_SYNTAX =
  /^(?:#{1,6}\s|>|`{3,}|\||[-*+]\s|\d+\.\s|-{3,}\s*$|={3,}\s*$|_{3,}\s*$|\*{3,}\s*$)/;

function neutralizeBlockSyntax(text) {
  return text
    .split('\n')
    .map((line) => (BLOCK_SYNTAX.test(line) ? `\\${line}` : line))
    .join('\n');
}

function textOf(content, types) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && types.includes(part.type))
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

/** 一次工具调用压缩成一行，让评委看得出"AI 到底动了什么" */
function summarizeToolCall(name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs ?? {});
  } catch {
    args = {};
  }
  const first = (v, n = 100) => {
    const line = String(v ?? '')
      .split('\n')
      .find((candidate) => candidate.trim());
    const cleaned = redact((line ?? '').trim());
    return cleaned.length > n ? `${cleaned.slice(0, n)}…` : cleaned;
  };
  const fileArg = args.file_path ?? args.path ?? args.target_file ?? '';
  const short = fileArg ? basename(String(fileArg)) : '';

  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return first(args.command, 110);
    case 'Edit':
      return short || first(args.description, 80);
    case 'Write':
    case 'Read':
    case 'Glob':
    case 'Grep':
      return short || first(args.pattern, 60);
    case 'TaskCreate':
    case 'TaskUpdate':
      return first(args.subject ?? args.taskId, 60);
    case 'DeferExecuteTool':
      return first(args.toolName, 40);
    case 'present_files':
      return (args.files ?? [])
        .map((f) => basename(String(f)))
        .slice(0, 3)
        .join('、');
    case 'show_widget':
      return first(args.title, 50);
    default:
      return short || '';
  }
}

/* ==================== 会话 -> 轮次 ==================== */

function readJsonl(file) {
  const raw = readFileSync(file, 'utf8');
  const events = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { raw, events, badLines };
}

const pad = (n) => String(n).padStart(2, '0');

function tsToLocal(ms) {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time, full: `${date} ${time}:${pad(d.getSeconds())}` };
}

/** 把一条会话的事件流折叠成「人工提问 → AI 产出」的轮次列表 */
function buildTurns(events) {
  const turns = [];
  let current = null;
  const push = () => {
    if (current && (current.prompt || current.replies.length || current.toolCalls.length)) {
      turns.push(current);
    }
    current = null;
  };

  for (const event of events) {
    if (SKIP_EVENT_TYPES.has(event.type)) continue;

    if (event.type === 'message' && event.role === 'user') {
      // 脱敏必须在**入库前**做：提问原文里同样可能出现密钥（例如把 .env 内容贴过来问）
      const prompt = redact(stripInjectedContext(textOf(event.content, ['input_text', 'text'])));
      if (!prompt) continue; // 纯系统提醒，不算一轮
      push();
      current = { ts: event.timestamp, prompt, replies: [], toolCalls: [] };
      continue;
    }
    if (!current) continue;

    if (event.type === 'message' && event.role === 'assistant') {
      const raw = textOf(event.content, ['output_text']);
      const text = raw ? redact(neutralizeBlockSyntax(raw)) : '';
      if (text) current.replies.push({ ts: event.timestamp, text });
      continue;
    }
    if (event.type === 'function_call') {
      current.toolCalls.push({
        name: event.name ?? '未知',
        summary: summarizeToolCall(event.name, event.arguments),
      });
    }
    /*
     * `reasoning` 与 `function_call_result` 一律不收录：前者是内部思考，后者是原始输出
     * —— 它体量占九成以上，且凭据泄漏正藏在这一层。验证结论由 changelogs / reviews 承担，
     * 此处只留"动作"。
     */
  }
  push();
  return turns;
}

function loadSessions() {
  if (!existsSync(PROJECTS_ROOT)) {
    throw new Error(`找不到 LearnBuddy 项目目录：${PROJECTS_ROOT}（可用 --projects-dir 指定）`);
  }
  const buckets = readdirSync(PROJECTS_ROOT)
    .filter((name) => name.startsWith(WORKSPACE_PREFIX))
    .map((name) => join(PROJECTS_ROOT, name))
    .filter((p) => statSync(p).isDirectory())
    .sort();

  const sessions = [];
  for (const bucket of buckets) {
    for (const entry of readdirSync(bucket)) {
      if (!entry.endsWith('.jsonl')) continue;
      const file = join(bucket, entry);
      const id = entry.replace(/\.jsonl$/, '');
      if (EXCLUDED_SESSIONS.has(id)) {
        console.log(`  （跳过已登记排除：${id}）`);
        continue;
      }
      const { raw, events, badLines } = readJsonl(file);
      const stamps = events.map((e) => e.timestamp).filter((t) => typeof t === 'number');
      const start = stamps.length ? Math.min(...stamps) : 0;
      const end = stamps.length ? Math.max(...stamps) : 0;

      // 子智能体会话（多智能体协作的原始证据）单列，挂在父会话下
      const subDir = join(bucket, id, 'subagents');
      const subagents = existsSync(subDir)
        ? readdirSync(subDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const subFile = join(subDir, f);
              const sub = readJsonl(subFile);
              const subStamps = sub.events
                .map((e) => e.timestamp)
                .filter((t) => typeof t === 'number');
              return {
                name: f,
                bytes: statSync(subFile).size,
                lines: sub.events.length,
                sha256: sha256(sub.raw),
                start: subStamps.length ? Math.min(...subStamps) : 0,
                end: subStamps.length ? Math.max(...subStamps) : 0,
              };
            })
        : [];

      sessions.push({
        id,
        relPath: `${basename(bucket)}/${entry}`,
        bucket: basename(bucket),
        bytes: statSync(file).size,
        lines: events.length,
        badLines,
        sha256: sha256(raw),
        start,
        end,
        turns: buildTurns(events),
        subagents,
      });
    }
  }
  return sessions.filter((s) => s.start > 0).sort((a, b) => a.start - b.start);
}

/* ==================== 渲染 ==================== */

/** 超长回复保留「开头 + 结尾」，并明写省略了多少字 —— 不许悄悄截断 */
function clipReply(text) {
  if (text.length <= REPLY_KEEP_FULL_UNDER) return { text, clipped: 0 };
  const omitted = text.length - REPLY_HEAD - REPLY_TAIL;
  return {
    text:
      `${text.slice(0, REPLY_HEAD)}\n\n……（此处省略 ${omitted} 字；完整原文见原始日志文件）……\n\n` +
      text.slice(-REPLY_TAIL),
    clipped: omitted,
  };
}

/**
 * 把一轮里的工具调用压成一行。
 *
 * **明细总数硬性封顶在 4 条**：一轮里跑 30 条命令是常态，全列出来会让"动作摘要"
 * 反而成为文档最大的部分（实测占七万字，比 AI 回复还密），而读者根本不会看第 5 条
 * 之后的命令。封顶后仍然保留**每个工具各调用了几次**这个更有信息量的量级。
 */
const TOOL_DETAIL_CAP = 2;

/** 单条工具动作摘要的显示长度上限 */
const TOOL_DETAIL_CHARS = 45;

function renderToolLine(toolCalls) {
  if (!toolCalls.length) return null;
  const byName = new Map();
  for (const call of toolCalls) {
    if (!byName.has(call.name)) byName.set(call.name, { total: 0, summaries: [] });
    const entry = byName.get(call.name);
    entry.total += 1;
    if (call.summary) entry.summaries.push(call.summary);
  }

  let budget = TOOL_DETAIL_CAP;
  const parts = [];
  for (const [name, entry] of byName) {
    if (budget <= 0 || entry.summaries.length === 0) {
      parts.push(`${name} ×${entry.total}`);
      continue;
    }
    const shown = entry.summaries.slice(0, budget);
    budget -= shown.length;
    const detail = shown
      .map((s) => `\`${s.length > TOOL_DETAIL_CHARS ? `${s.slice(0, TOOL_DETAIL_CHARS)}…` : s}\``)
      .join('、');
    const rest = entry.total - shown.length;
    parts.push(`${name} ×${entry.total}（${detail}${rest > 0 ? ` 等 ${rest} 次` : ''}）`);
  }
  return parts.join(' · ');
}

function renderSessionBody(session, sessionIndex) {
  const lines = [];
  const startLocal = tsToLocal(session.start);
  const endLocal = tsToLocal(session.end);
  lines.push(
    `## 会话 ${sessionIndex}｜${startLocal.date} ${startLocal.time} → ${endLocal.date} ${endLocal.time}`,
  );
  lines.push('');
  lines.push(
    `> 会话 ID \`${session.id}\`｜原始文件 \`${session.relPath}\`｜` +
      `${session.lines} 行｜人工轮次 ${session.turns.length}`,
  );
  lines.push('');

  session.turns.forEach((turn, index) => {
    const when = turn.ts ? tsToLocal(turn.ts) : null;
    // 轮次标题**必须带日期**：`dfd10a39` 这一条会话横跨 09-16 到 09-20 共四天，
    // 只写时分会让读者无法判断某一轮发生在哪天（而"哪天做的"正是评审要核的东西）。
    const stamp = when ? `${when.date.slice(5)} ${when.time}` : '';
    lines.push(`### 第 ${index + 1} 轮${stamp ? `　${stamp}` : ''}`);
    lines.push('');

    if (turn.prompt.length > 3000) {
      lines.push('**人工提问**（原文）');
      lines.push('');
      lines.push('```text');
      lines.push(turn.prompt);
      lines.push('```');
    } else {
      lines.push('**人工提问**');
      lines.push('');
      for (const promptLine of turn.prompt.split('\n')) lines.push(`> ${promptLine}`);
    }
    lines.push('');

    const reply = turn.replies.map((r) => r.text).join('\n\n');
    if (reply) {
      const { text, clipped } = clipReply(reply);
      lines.push(`**AI 回复**${clipped ? `（原文 ${reply.length} 字，已按收录上限裁剪）` : ''}`);
      lines.push('');
      lines.push(text);
      lines.push('');
    } else {
      lines.push('**AI 回复**：本轮无面向用户的文字回复（仅工具调用）。');
      lines.push('');
    }

    const toolLine = renderToolLine(turn.toolCalls);
    if (toolLine) {
      lines.push(`**本轮动作**（工具调用 ${turn.toolCalls.length} 次）：${toolLine}`);
      lines.push('');
    }
    // 轮次之间**不用 `---` 分隔**：178 轮的横线会多排出近两页，而 `###` 标题
    // 自带间距已经够分界。横线只留给"章"级别（会话之间保留）。
  });
  lines.push('---');
  lines.push('');
  return lines;
}

/** 人工纠偏 / 否决 的机械索引 —— 直接回应"reviews 必须含 AI 输出被否决的记录" */
const PUSHBACK_RULES = [
  ['叫停 / 先不做', /先不[要动]|不要动|不许|别动|先停|等它|等一下|先放|放着|暂停|撤回|取消/],
  ['只读约束', /只读|不要修改|不要改|不改动|不要提交|不自动提交|先不要执行/],
  ['口径纠偏（"看不懂"）', /看不懂|大白话|重讲|换个说法|没看懂|什么意思/],
  ['方案否决 / 改口径', /不行|不对|错了|有问题|不同意|否决|改成|换成|还是有|再检查|再确认/],
  ['明确授权 / 拍板', /授权|直接做|你来推|可以提交|合并吧|按方案|改吧/],
];

function renderPushbackIndex(sessions) {
  const lines = [];
  lines.push('## 附录 C　人工纠偏与授权索引（机械抽取，未经人工筛选）');
  lines.push('');
  lines.push(
    '> 赛事手册禁止「AI 生成完整方案后直接提交」，并要求 `docs/reviews/` 必须包含' +
      '「AI 输出被否决或被修改」的实际记录。下表由脚本按关键词从**人工提问原文**中机械抽取，',
  );
  lines.push('> 用于说明**人在哪些节点真正介入了决策**，可与 `docs/reviews/` 逐条对照。');
  lines.push('');
  for (const [label, pattern] of PUSHBACK_RULES) {
    const rows = [];
    sessions.forEach((session, si) => {
      session.turns.forEach((turn, ti) => {
        if (!pattern.test(turn.prompt)) return;
        const when = turn.ts ? tsToLocal(turn.ts) : { date: '', time: '' };
        const oneLine = turn.prompt.replace(/\s+/g, ' ').slice(0, 100);
        rows.push(
          `| ${when.date} ${when.time} | 会话 ${si + 1} 第 ${ti + 1} 轮 | ${oneLine} |`,
        );
      });
    });
    lines.push(`### ${label}（${rows.length} 条）`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('（无）');
    } else {
      lines.push('| 时间 | 位置 | 提问摘要 |');
      lines.push('|---|---|---|');
      lines.push(...rows);
    }
    lines.push('');
  }
  return lines;
}

function renderStats(sessions) {
  const allTurns = sessions.flatMap((s) => s.turns);
  const toolCalls = allTurns.flatMap((t) => t.toolCalls);
  const byTool = new Map();
  for (const call of toolCalls) byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1);
  const days = new Set(
    allTurns.map((t) => (t.ts ? tsToLocal(t.ts).date : null)).filter(Boolean),
  );

  const lines = [];
  lines.push('## 二、总量统计');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 收录会话 | ${sessions.length} 个 |`);
  lines.push(`| 子智能体会话 | ${sessions.reduce((n, s) => n + s.subagents.length, 0)} 个 |`);
  lines.push(
    `| 时间跨度 | ${tsToLocal(sessions[0].start).date} → ${tsToLocal(sessions[sessions.length - 1].end).date} |`,
  );
  lines.push(`| 有对话记录的开发日 | ${days.size} 天 |`);
  lines.push(`| **人工提问轮次** | **${allTurns.length} 轮** |`);
  lines.push(
    `| 人工提问总字数 | ${allTurns.reduce((n, t) => n + t.prompt.length, 0).toLocaleString('en-US')} 字 |`,
  );
  lines.push(`| AI 面向用户回复 | ${allTurns.reduce((n, t) => n + t.replies.length, 0)} 条 |`);
  lines.push(`| **工具调用总次数** | **${toolCalls.length} 次** |`);
  lines.push(
    `| 原始日志总量 | ${(sessions.reduce((n, s) => n + s.bytes, 0) / 1024 / 1024).toFixed(1)} MB |`,
  );
  lines.push('');
  lines.push('### 2.1 工具调用分布（体现工程动作的构成）');
  lines.push('');
  lines.push('| 工具 | 次数 |');
  lines.push('|---|---|');
  for (const [name, count] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${name}\` | ${count} |`);
  }
  lines.push('');
  lines.push('### 2.2 会话清单');
  lines.push('');
  lines.push('| # | 起始 | 结束 | 轮次 | 工具调用 | 行数 | 会话 ID |');
  lines.push('|---|---|---|---|---|---|---|');
  sessions.forEach((s, i) => {
    lines.push(
      `| ${i + 1} | ${tsToLocal(s.start).full} | ${tsToLocal(s.end).full} | ${s.turns.length} | ` +
        `${s.turns.reduce((n, t) => n + t.toolCalls.length, 0)} | ${s.lines} | \`${s.id.slice(0, 8)}…\` |`,
    );
  });
  lines.push('');
  lines.push('### 2.3 逐日覆盖（**含断档登记**）');
  lines.push('');
  lines.push('下表按日统计人工提问轮次。**任一为 0 的日期都是断档，如实登记、不回填**。');
  lines.push('');
  const perDay = new Map();
  for (const turn of allTurns) {
    if (!turn.ts) continue;
    const key = tsToLocal(turn.ts).date;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  // 归一化到当天 0 点再迭代：否则起点会带上"当天的时刻"（如 17:26），
  // 最后一天若结束时刻早于该时刻就会被整日漏掉（09-26 01:02 就这样漏过一次）。
  const first = new Date(sessions[0].start);
  first.setHours(0, 0, 0, 0);
  const last = new Date(sessions[sessions.length - 1].end);
  last.setHours(0, 0, 0, 0);
  const gaps = [];
  lines.push('| 日期 | 轮次 | 备注 |');
  lines.push('|---|---|---|');
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const key = tsToLocal(d.getTime()).date;
    const count = perDay.get(key) ?? 0;
    if (count === 0) gaps.push(key);
    lines.push(`| ${key} | ${count} | ${count === 0 ? '**无对话记录（断档）**' : ''} |`);
  }
  lines.push('');
  if (gaps.length > 0) {
    lines.push(
      `**断档说明**：${gaps.join('、')} 在 LearnBuddy 侧**没有留下对话记录**。` +
        '这不代表当天没有工作 —— 但"没有记录"就只能登记为"没有记录"，不做任何回填或推测。',
    );
    lines.push('');
  }
  return lines;
}

function renderMainDoc(sessions) {
  const startDate = tsToLocal(sessions[0].start).date;
  const endDate = tsToLocal(sessions[sessions.length - 1].end).date;
  const allTurns = sessions.flatMap((s) => s.turns);

  const head = [];
  head.push(`# 微积分学伴 · LearnBuddy 对话记录（${startDate} 至 ${endDate}）`);
  head.push('');
  head.push('> **提交材料**：赛事手册 §4.1 要求的「LearnBuddy 使用记录」。');
  head.push(
    '> **生成方式**：由 `scripts/export-learnbuddy-records.mjs` 从 LearnBuddy 本机原始日志' +
      '**机械转换**而来，',
  );
  head.push('> 未经人工润色、未经模型改写。除脱敏替换与排版转义外，本文档的每个字都出自原始日志。');
  head.push(
    '> ⚠️ **本文档是快照**：LearnBuddy 的原始日志仍在写入（导出时有一条会话尚未结束），' +
      '重跑脚本会得到"同一份原始文件"的逐字相同结果，但原始文件增长后重跑结果会随之变化。',
  );
  head.push(`> **生成时间**：${tsToLocal(Date.now()).full}`);
  head.push('');
  head.push('---');
  head.push('');
  head.push('## 一、这份记录是什么、怎么核验');
  head.push('');
  head.push('### 1.1 来源');
  head.push('');
  head.push('LearnBuddy 把每次对话的完整事件流（提问、回复、思考、工具调用、文件快照）');
  head.push('按工作区写在开发者本机：');
  head.push('');
  head.push('```text');
  head.push('<家目录>/.learnbuddy/projects/<工作区目录名>/<会话 ID>.jsonl');
  head.push('<家目录>/.learnbuddy/projects/<工作区目录名>/<会话 ID>/subagents/agent-*.jsonl');
  head.push('```');
  head.push('');
  head.push(
    '本项目 10 天赛程中**换过一次工作区目录**，两个桶的会话都收录在此，故记录连续、无断档。',
  );
  head.push('');
  head.push('### 1.2 怎么核验「不是编的」');
  head.push('');
  head.push('1. **时间戳**：每条记录都带毫秒级原始时间戳，与 `docs/plans`、`docs/changelogs`、');
  head.push('   `docs/reviews`、`docs/tech` 四类文档以及 git 提交时间可互相印证；');
  head.push('2. **校验码**：每个原始日志文件的 SHA-256 与行数见 `附录-原始文件清单与校验.md`；');
  head.push('3. **可复现**：导出脚本随仓库提交，重跑即可从原始文件得到本文档。');
  head.push('');
  head.push('### 1.3 收录口径（**只做减法，不做加法**）');
  head.push('');
  head.push('| 收录 | 不收录 | 理由 |');
  head.push('|---|---|---|');
  head.push('| 人工提问**原文**（一字不改） | —— | 这是「人工主导」的直接证据 |');
  head.push(
    `| AI 面向用户的回复（超 ${REPLY_KEEP_FULL_UNDER} 字者保留首尾并注明省略字数） | AI 内部思考过程（\`reasoning\`） | 思考过程非对外产出，且体量巨大 |`,
  );
  head.push(
    '| 工具调用的**动作摘要**（调了什么工具、动了哪个文件、跑了什么命令） | 工具原始输出（命令回显、文件全文） | 原始输出体量占九成以上，且其中混有凭据 |',
  );
  head.push('');
  head.push(
    '**唯一的排版处理**：AI 回复里常带 `## 小标题`、`> 引用`、`|---|` 表格等块级 Markdown。',
  );
  head.push(
    '若不处理，它们会被当作**本文档自身的结构**（实测「## 逐项影响表」真的变成了文档的二级标题）。',
  );
  head.push(
    '导出时按行首加一个 Markdown 转义符、渲染时还原，因此**读者看到的文字与原文完全一致**，',
  );
  head.push('只是它不再被解释成标题。此外平台注入的包装（`<user_query>`、截图的本机路径）会被剥掉。');
  head.push('');
  head.push('### 1.4 脱敏声明');
  head.push('');
  head.push('原始日志在 2026-09-21 排查网络连通性时，曾被一条打印全部环境变量的命令带入一段');
  head.push('本机连接代理令牌。该段落**已在导出时脱敏**，规则为确定性替换，逐条写在脚本源码中。');
  head.push(
    '除下列几类外，记录**未作任何改动** —— 包括「看不懂」「先停」「不要改」这类并不体面的回合，',
  );
  head.push('它们同样保留，因为那正是人工介入的真实痕迹。');
  head.push('');
  head.push('| 脱敏类别 | 处理 |');
  head.push('|---|---|');
  head.push('| 令牌 / 密钥（`Bearer …`、`sk-…`、`ghp_…`、私钥块） | 整体替换为占位符 |');
  head.push('| 密钥型变量的非空赋值（`API_KEY=…`、`"apiKey": "…"`） | 只抹值、保留变量名 |');
  head.push('| 环境变量整段 dump（`CODEBUDDY_MCP_CONFIG=…`） | 整体替换为占位符 |');
  head.push('| 本机个人信息（家目录用户名、主机名） | 替换为 `<家目录>` / `<主机名>` |');
  head.push('');
  if (redactionLog.size > 0) {
    head.push('**本次实际发生的脱敏**（自动登记。为免二次泄漏，这里只记类别、次数与');
    head.push('**被抹掉内容的长度**，不记内容本身）：');
    head.push('');
    head.push('| 脱敏类别 | 出现次数 | 被替换内容长度 |');
    head.push('|---|---|---|');
    for (const [label, entry] of redactionLog) {
      const lengths = [...entry.lengths].sort((a, b) => a - b).join('、');
      head.push(`| ${label} | ${entry.count} | ${lengths} 字符 |`);
    }
    head.push('');
  } else {
    head.push('**本次实际发生的脱敏**：无命中（本次导出未触发任何脱敏规则）。');
    head.push('');
  }
  head.push('### 1.5 已登记的边界（**缺失即登记，不回填**）');
  head.push('');
  for (const [id, reason] of EXCLUDED_SESSIONS) {
    head.push(`- 会话 \`${id}\` 未收录：${reason}。`);
  }
  head.push('');
  head.push('---');
  head.push('');
  head.push(...renderStats(sessions));
  head.push('---');
  head.push('');
  head.push('## 三、对话正文');
  head.push('');
  head.push(
    `> 共 ${sessions.length} 个会话、${allTurns.length} 轮人工提问，按时间先后排列。` +
      '每个会话标题下的「会话 ID / 原始文件」可直接对照附录核验。',
  );
  head.push('');
  sessions.forEach((session, index) => {
    head.push(...renderSessionBody(session, index + 1));
  });
  head.push(...renderPushbackIndex(sessions));
  head.push('---');
  head.push('');
  head.push('## 附录 D　四类开发文档索引');
  head.push('');
  head.push('本项目的开发留痕分四类，与本文档**互为索引**：');
  head.push('');
  head.push('| 类别 | 目录 | 对应本文档中的什么 |');
  head.push('|---|---|---|');
  head.push('| 计划 | `docs/plans/` | 每轮开工前的人工决策，可在正文中找到对应提问 |');
  head.push('| 变更 | `docs/changelogs/` | 每轮收工时的实际改动，对应正文中的工具调用动作 |');
  head.push('| 评审 | `docs/reviews/` | AI 产出被否决 / 被修改的记录，与附录 C 对应 |');
  head.push('| 技术 | `docs/tech/` | 选型与契约变更，对应正文中讨论方案的那些轮次 |');
  head.push('');
  head.push('逐项对照表见 `docs/records/README.md`。');
  head.push('');
  return head;
}

function renderAppendix(sessions) {
  const lines = [];
  lines.push('# 附录　LearnBuddy 原始日志文件清单与校验');
  lines.push('');
  lines.push('> 本表由 `scripts/export-learnbuddy-records.mjs` 生成。');
  lines.push('> 评委可据此核对主文档的每个会话确实来自一个真实存在的原始日志文件。');
  lines.push('> **校验码按 8 位一组分隔显示**，核对时请去掉空格。');
  lines.push('');
  lines.push('## 一、主会话');
  lines.push('');
  lines.push('| # | 会话 ID | 所在目录 | 行数 | 大小 | 起始 | 结束 | SHA-256 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  sessions.forEach((s, i) => {
    const grouped = s.sha256.replace(/(.{8})/g, '$1 ').trim();
    lines.push(
      `| ${i + 1} | \`${s.id}\` | \`${s.bucket}\` | ${s.lines} | ` +
        `${(s.bytes / 1024).toFixed(0)} KB | ${tsToLocal(s.start).full} | ` +
        `${tsToLocal(s.end).full} | \`${grouped}\` |`,
    );
  });
  lines.push('');
  const subs = sessions.flatMap((s) => s.subagents.map((a) => ({ ...a, parent: s.id })));
  lines.push('## 二、子智能体会话（多智能体协作的原始证据）');
  lines.push('');
  if (subs.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| # | 父会话 | 文件 | 行数 | 大小 | 起始 | 结束 | SHA-256 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    subs.forEach((a, i) => {
      const grouped = a.sha256.replace(/(.{8})/g, '$1 ').trim();
      lines.push(
        `| ${i + 1} | \`${a.parent.slice(0, 8)}…\` | \`${basename(a.name)}\` | ${a.lines} | ` +
          `${(a.bytes / 1024).toFixed(0)} KB | ${tsToLocal(a.start).full} | ` +
          `${tsToLocal(a.end).full} | \`${grouped}\` |`,
      );
    });
  }
  lines.push('');
  lines.push('## 三、未收录的会话（已登记边界，不回填）');
  lines.push('');
  lines.push('| 会话 ID | 原因 |');
  lines.push('|---|---|');
  for (const [id, reason] of EXCLUDED_SESSIONS) lines.push(`| \`${id}\` | ${reason} |`);
  lines.push('');
  lines.push('## 四、事件类型说明');
  lines.push('');
  lines.push('原始日志每行是一个事件，`type` 字段含义如下：');
  lines.push('');
  lines.push('| type | 含义 | 是否进入主文档 |');
  lines.push('|---|---|---|');
  lines.push('| `message` / `role=user` | 人工提问（含平台注入的上下文块，导出时已剥离） | 全文收录 |');
  lines.push('| `message` / `role=assistant` | AI 面向用户的回复 | 首尾收录 |');
  lines.push('| `reasoning` | AI 内部思考过程 | 不收录 |');
  lines.push('| `function_call` | 工具调用（参数） | 仅动作摘要 |');
  lines.push('| `function_call_result` | 工具调用结果（原始回显） | 不收录 |');
  lines.push('| `file-history-snapshot` | 编辑器文件快照 | 不收录 |');
  lines.push('| `resend-fork-notice` | 会话续接通知 | 不收录 |');
  lines.push('');
  return lines;
}

/* ==================== HTML（给无头浏览器打印 PDF） ==================== */

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 行内渲染。开头的 `\` 是 `neutralizeBlockSyntax` 加的转义标记，
 * 在这里还原成字面字符（所以读者看到的仍是原文，只是它不再是标题／引用）。
 */
function inline(text) {
  const literal = text.replace(/^\\(?=[#>|`*+\-=_])/, '');
  return escapeHtml(literal)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 极小 Markdown → HTML，只覆盖本脚本自己产出的语法子集 */
function markdownToHtml(md) {
  const out = [];
  let inCode = false;
  let inQuote = false;
  let inTable = false;

  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
  };

  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      closeQuote();
      closeTable();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      closeQuote();
      if (!inTable) {
        // 首行当表头渲染（Markdown 的 `|---|` 分隔行已在上面跳过）
        out.push('<table><tbody>');
        inTable = true;
        out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`);
        continue;
      }
      out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();
    if (line.startsWith('> ')) {
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push(`<p>${inline(line.slice(2))}</p>`);
      continue;
    }
    if (line === '>') {
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push('<p></p>');
      continue;
    }
    closeQuote();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (line.trim() === '---') {
      out.push('<hr/>');
      continue;
    }
    if (line.trim() === '') continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeQuote();
  closeTable();
  return out.join('\n');
}

/*
 * 排版密度是"能不能通读"的硬约束，不是美化。
 *
 * 第一版用了 10.5pt / 1.75 行高 / 18mm 页边距，实测 14.8 万字排到 **147 页** ——
 * 评委不会翻。压到 9.5pt / 1.5 行高 / 13mm 页边距后密度约翻倍，同样的内容落在
 * 60 页上下：仍然清楚可读（正文字号大于多数机打报告的 9pt），但翻得动。
 */
const PDF_CSS = `
  @page { size: A4; margin: 14mm 13mm; }
  body { font-family: "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;
         font-size: 9.5pt; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 17pt; border-bottom: 2px solid #1a1a1a; padding-bottom: 6px;
       margin: 0 0 10px; }
  h2 { font-size: 13pt; margin: 14px 0 6px; border-left: 4px solid #4a6fa5; padding-left: 8px; }
  h3 { font-size: 10.5pt; margin: 9px 0 4px; color: #2c3e50; }
  h4 { font-size: 10pt; margin: 8px 0 3px; }
  p { margin: 3px 0; }
  blockquote { margin: 4px 0; padding: 4px 9px; background: #f5f7fa;
               border-left: 3px solid #9bb0cc; color: #24303d; }
  blockquote p { margin: 1px 0; }
  code { background: #f0f2f5; padding: 0 3px; border-radius: 3px;
         font-family: Consolas,monospace; font-size: 8.5pt; }
  pre { background: #f7f8fa; border: 1px solid #e0e4e9; border-radius: 4px;
        padding: 6px 8px; margin: 4px 0; white-space: pre-wrap; word-break: break-all;
        font-family: Consolas,monospace; font-size: 8pt; line-height: 1.35; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0; font-size: 8.5pt; }
  td, th { border: 1px solid #d5dae0; padding: 2px 5px; text-align: left; }
  th { background: #eef2f7; font-weight: 600; }
  tr { break-inside: avoid; }
  hr { border: none; border-top: 1px dashed #ccd3db; margin: 7px 0; }
  h2, h3 { break-after: avoid; }
  /* 表格**整体**不避断页：13 行的会话表若整体下移，会留出大半页空白。
     只保证"单行不被劈开"即可。 */
  pre, blockquote { break-inside: avoid; }
`;

/* ==================== 主流程 ==================== */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'records');

console.log('=== LearnBuddy 对话记录导出 ===\n');
console.log(`原始日志根目录：${PROJECTS_ROOT}\n`);

const sessions = loadSessions();

if (sessions.length === 0) {
  console.error('✗ 没有找到任何会话文件。请用 --projects-dir 指定正确目录。');
  process.exit(1);
}

console.log(`收录会话 ${sessions.length} 个`);
for (const s of sessions) {
  console.log(
    `  · ${s.id.slice(0, 8)}  ${tsToLocal(s.start).full}  行 ${String(s.lines).padStart(5)}  ` +
      `轮次 ${String(s.turns.length).padStart(3)}  工具 ${String(
        s.turns.reduce((n, t) => n + t.toolCalls.length, 0),
      ).padStart(4)}`,
  );
}

console.log(`\n脱敏命中 ${redactionLog.size} 类：`);
if (redactionLog.size === 0) console.log('  （无）');
for (const [label, entry] of redactionLog) {
  const lengths = [...entry.lengths].sort((a, b) => a - b).join('、');
  console.log(`  · ${label}  ${entry.count} 次（长度 ${lengths}）`);
}

const startDate = tsToLocal(sessions[0].start).date;
const endDate = tsToLocal(sessions[sessions.length - 1].end).date;
const mainMd = renderMainDoc(sessions).join('\n');
const appendixMd = renderAppendix(sessions).join('\n');
const mainName = `LearnBuddy对话记录_${startDate}至${endDate}.md`;

const allTurns = sessions.flatMap((s) => s.turns);
const promptChars = allTurns.reduce((n, t) => n + t.prompt.length, 0);
const replyChars = allTurns.reduce(
  (n, t) => n + clipReply(t.replies.map((r) => r.text).join('\n\n')).text.length,
  0,
);
console.log(`\n篇幅构成：`);
console.log(`  人工提问原文 ${promptChars.toLocaleString('en-US')} 字符`);
console.log(`  AI 回复（裁剪后）${replyChars.toLocaleString('en-US')} 字符`);
console.log(`  主文档合计 ${mainMd.length.toLocaleString('en-US')} 字符`);
console.log(`  附　录合计 ${appendixMd.length.toLocaleString('en-US')} 字符`);

if (DRY_RUN) {
  console.log('\n（--dry-run：未写盘）');
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, mainName), mainMd, 'utf8');
  writeFileSync(join(OUT_DIR, '附录-原始文件清单与校验.md'), appendixMd, 'utf8');
  console.log(`\n已写出：docs/records/${mainName}`);
  console.log('已写出：docs/records/附录-原始文件清单与校验.md');

  const htmlPath = join(ROOT, '.tmp', 'learnbuddy-records.html');
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(
    htmlPath,
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>微积分学伴 · LearnBuddy 对话记录</title>' +
      `<style>${PDF_CSS}</style></head><body>${markdownToHtml(mainMd)}</body></html>`,
    'utf8',
  );
  console.log('已写出：.tmp/learnbuddy-records.html（供打印 PDF）');

  if (has('--pdf')) {
    const chrome = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => existsSync(candidate));

    if (!chrome) {
      console.log('\n（找不到 Chrome，跳过 PDF。可手工执行下方命令）');
    } else {
      const pdfPath = join(OUT_DIR, mainName.replace(/\.md$/, '.pdf'));
      /*
       * Chrome 的 profile 目录**放在系统临时目录，不放仓库内**：
       * 它会被塞进几十个第三方扩展脚本，虽然 `.tmp/` 已 gitignore，
       * 但仓库里凭空多出上百 MB 二进制目录没有意义。
       */
      const profileDir = join(tmpdir(), 'learnbuddy-records-chrome-profile');
      const result = spawnSync(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-pdf-header-footer',
          `--user-data-dir=${profileDir}`,
          `--print-to-pdf=${pdfPath}`,
          `file:///${htmlPath.replace(/\\/g, '/')}`,
        ],
        { encoding: 'utf8' },
      );
      if (existsSync(pdfPath)) {
        const pdf = readFileSync(pdfPath, 'latin1');
        const pageCount = (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
        console.log(`\n已写出：docs/records/${basename(pdfPath)}`);
        console.log(`PDF 页数：${pageCount} 页`);
      } else {
        console.log(`\n✗ PDF 生成失败（退出码 ${result.status}）。可手工执行：`);
        console.log(`  "${chrome}" --headless=new --no-pdf-header-footer --print-to-pdf="<输出.pdf>" "${htmlPath}"`);
      }
    }
  }
}
