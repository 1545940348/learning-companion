/**
 * LaTeX → 表达式 **白名单** 转换（`P-B13`，符号验证的前置）
 *
 * 对应 `docs/tech/2026-09-17-符号验证引擎选型-纯TS.md` §4.3：
 * 「`mathjs` 接受表达式字符串而非 LaTeX。课程范围内符号有限，采用**白名单映射表**；
 * **转换失败即标 `unverified`，不做猜测性修复**。」
 *
 * ### 「白名单」是什么意思（这条决定了本文件的写法）
 *
 * 不是"尽力而为地理解任意 LaTeX"，而是：
 * 1. 只认下表登记的命令 / 记号；
 * 2. 转换完之后，结果必须**只由允许的记号组成**（数字、变量 `x`、`sqrt`/`abs`、
 *    `+ - * / ^ ( ) ,`）；
 * 3. 出现任何未登记的东西 —— 包括未登记的命令、未登记的变量名、残留的 `{ } \` ——
 *    一律 `{ ok: false }`，**不猜、不兜底**。
 *
 * 为什么必须这么严：`mathjs` 的 `derivative()` 对**垃圾输入不报错**。实测（2026-09-20）：
 * `derivative('not-an-expr', 'x')` 返回 **`0`**，`derivative('x^2', 'y')` 也返回 **`0`**
 * —— 于是"表达式根本没被理解"会伪装成一个**看起来合理的结论**。
 * 白名单是这条链上唯一能挡住它的闸门。
 *
 * ### 课程范围
 *
 * 课程严格限定「导数 / 切线 / 单调性」（一元函数微分学）。因此：
 * - **只放行变量 `x`**，不放行 `pi` / `e` 等常量；
 * - **不放行三角函数与对数/指数**（选型文档 §4.4 第 4 条：涉及三角/超越函数的结论
 *   在本课程范围内不出现）—— 它们会落到 `ok: false`，进而标 `unverified`。
 *
 * ### 允许的输入形态（有意识的设计，已如实登记）
 *
 * - 结尾/开头允许 `$...$` 与 `\(...\)` 数学定界符（模型常带）；
 * - 允许**剥掉等号左侧的固定写法**（`y =`、`f(x) =`、`f'(x) =`、`f''(x) =`）。
 *   这是**有界的规范化**，不是"猜测性修复"：只剥左侧、有固定形态、右侧一字不动；
 *   剥完之后若**仍有等号**（说明是方程或关系式，不是表达式）→ `ok: false`。
 * - **不做**隐式乘法补 `*`：实测 `mathjs` 自己能解析 `3x`、`2(x+1)`，
 *   交给它去解析即可；我们**不替它猜**。
 */

export type LatexConversion =
  | { ok: true; expr: string; notes: string[] }
  | { ok: false; reason: string };

/** 登记的命令 → 替换文本。**不在这张表里的 `\xxx` 一律拒绝** */
const COMMAND_MAP: ReadonlyArray<readonly [string, string]> = [
  ['\\cdot', '*'],
  ['\\times', '*'],
  ['\\div', '/'],
  ['\\left', ''],
  ['\\right', ''],
  ['\\,', ''],
  ['\\;', ''],
  ['\\!', ''],
  ['\\ ', ' '],
  // `\(` `\)` 是行内公式定界符，不是数学记号
  ['\\(', ''],
  ['\\)', ''],
];

/** 允许的标识符（变量）。课程范围只有 `x` */
const ALLOWED_VARIABLES = new Set(['x']);
/** 允许的函数名（必须后跟括号） */
const ALLOWED_FUNCTIONS = new Set(['sqrt', 'abs']);

/** 全角/Unicode 记号归一 */
const UNICODE_NORMALIZE: ReadonlyArray<readonly [string, string]> = [
  ['−', '-'], // U+2212 减号
  ['–', '-'],
  ['—', '-'],
  ['×', '*'],
  ['·', '*'],
  ['÷', '/'],
  ['（', '('],
  ['）', ')'],
  ['，', ','],
  ['。', ''],
  ['\u00a0', ' '],
];

/**
 * 等号左侧的固定写法：`y =` / `f(x) =` / `f'(x) =` / `f''(x) =` / `f^{\prime}(x) =`。
 * 只剥这一种形态，且只剥一次。
 */
const ASSIGNMENT_PREFIX =
  /^\s*(?:y|f\s*(?:'+|\^\s*\{?\s*\\prime\s*\}?)*\s*\(\s*x\s*\))\s*=\s*/;

/** 取一个成对花括号组：`pos` 必须指向 `{` */
function readGroup(text: string, pos: number): { body: string; end: number } | null {
  if (text[pos] !== '{') return null;
  let depth = 0;
  for (let i = pos; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

type Step = { ok: true; text: string } | { ok: false; reason: string };

/**
 * 展开需要参数的命令（`\frac{}{}`、`\sqrt{}`、`^{}`、`_{}`）。
 * 逐轮展开最外层，嵌套由下一轮处理；轮数上限防病态输入。
 *
 * ⚠️ **必须在 `applySimpleCommands` 之后调用**：这样 `\left(`、`\cdot` 这类
 * 无参命令已被替换掉，此处剩下的 `\xxx` 就一定是**未登记**命令，报错信息才准确
 * （否则 `\sin{x}` 会被报成"花括号用法未登记"，指向错误的根因）。
 */
function expandCommands(input: string): Step {
  let text = input;
  for (let round = 0; round < 24; round += 1) {
    const frac = text.indexOf('\\frac');
    if (frac !== -1) {
      const numerator = readGroup(text, frac + 5);
      if (!numerator) return { ok: false, reason: '\\frac 的第一个参数不是成对的花括号' };
      const denominator = readGroup(text, numerator.end);
      if (!denominator) return { ok: false, reason: '\\frac 的第二个参数不是成对的花括号' };
      text = `${text.slice(0, frac)}((${numerator.body})/(${denominator.body}))${text.slice(denominator.end)}`;
      continue;
    }

    const sqrt = text.indexOf('\\sqrt');
    if (sqrt !== -1) {
      const after = sqrt + 5;
      // `\sqrt[n]{}` —— n 次根不在白名单内（课程范围只有平方根）
      if (text[after] === '[') {
        return { ok: false, reason: '\\sqrt 的 n 次根不在白名单内' };
      }
      const arg = readGroup(text, after);
      if (!arg) return { ok: false, reason: '\\sqrt 的参数不是成对的花括号' };
      text = `${text.slice(0, sqrt)}(sqrt(${arg.body}))${text.slice(arg.end)}`;
      continue;
    }

    const superscript = text.indexOf('^{');
    if (superscript !== -1) {
      const group = readGroup(text, superscript + 1);
      if (!group) return { ok: false, reason: '上标 `^{` 缺少成对的花括号' };
      text = `${text.slice(0, superscript)}^(${group.body})${text.slice(group.end)}`;
      continue;
    }

    const subscript = text.indexOf('_{');
    if (subscript !== -1) {
      const group = readGroup(text, subscript + 1);
      if (!group) return { ok: false, reason: '下标 `_{` 缺少成对的花括号' };
      const body = group.body.trim();
      // 下标只支持数字（如 `x_{1}` → `x_1`）；字母下标属未登记用法
      if (!/^\d+$/.test(body)) {
        return { ok: false, reason: `下标只支持数字（如 x_{1}），收到 \`${body}\`` };
      }
      text = `${text.slice(0, subscript)}_${body}${text.slice(group.end)}`;
      continue;
    }

    // 先报"未登记命令"（根因更准），再报"花括号用法"
    const leftover = /\\[A-Za-z]+/.exec(text);
    if (leftover) {
      return { ok: false, reason: `未登记的 LaTeX 命令：${leftover[0]}` };
    }
    if (text.includes('{') || text.includes('}')) {
      return { ok: false, reason: '存在未登记的花括号用法' };
    }
    return { ok: true, text };
  }
  return { ok: false, reason: 'LaTeX 嵌套层数超出上限' };
}

/** 替换登记表里的**无参**命令。此处不判定失败，剩余 `\xxx` 交给 `expandCommands` 报错 */
function applySimpleCommands(input: string): string {
  let text = input;
  for (const [command, replacement] of COMMAND_MAP) {
    text = text.split(command).join(replacement);
  }
  return text;
}

/** 逐记号检查：只允许数字、`x`（可带数字下标）、白名单函数、四则与括号 */
function checkTokens(input: string): Step {
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    const number = /^\d+(?:\.\d+)?/.exec(input.slice(i));
    if (number) {
      i += number[0].length;
      continue;
    }

    if ('+-*/^(),'.includes(ch)) {
      i += 1;
      continue;
    }

    const identifier = /^[A-Za-z]+(?:_\d+)?/.exec(input.slice(i));
    if (!identifier) {
      return { ok: false, reason: `表达式里出现白名单外的字符：\`${ch}\`` };
    }

    const token = identifier[0];
    const base = token.replace(/_\d+$/, '');
    const nextIsParen = input.slice(i + token.length).replace(/^\s*/, '').startsWith('(');

    if (ALLOWED_FUNCTIONS.has(base)) {
      if (!nextIsParen) {
        return { ok: false, reason: `函数 \`${base}\` 后必须跟括号` };
      }
    } else if (!ALLOWED_VARIABLES.has(token)) {
      return {
        ok: false,
        reason: `白名单外的变量或函数：\`${token}\`（课程范围只允许变量 x 与 sqrt/abs）`,
      };
    }
    i += token.length;
  }
  return { ok: true, text: input };
}

/**
 * 把 LaTeX（或已是表达式形态的字符串）转成 `mathjs` 可解析的表达式。
 *
 * **失败即失败**：返回 `{ ok: false, reason }`，由调用方标 `unverified`。
 * 绝不返回"尽量修好"的结果。
 */
export function latexToExpression(raw: unknown): LatexConversion {
  if (typeof raw !== 'string') {
    return { ok: false, reason: '表达式不是字符串' };
  }

  const notes: string[] = [];
  let text = raw.trim();

  if (text.length === 0) return { ok: false, reason: '表达式为空' };

  // `$...$` / `\(...\)` 定界符
  if (text.startsWith('$$') && text.endsWith('$$') && text.length >= 4) {
    text = text.slice(2, -2).trim();
  } else if (text.startsWith('$') && text.endsWith('$') && text.length >= 2) {
    text = text.slice(1, -1).trim();
  } else if (text.startsWith('\\(') && text.endsWith('\\)') && text.length >= 4) {
    text = text.slice(2, -2).trim();
  }

  for (const [from, to] of UNICODE_NORMALIZE) {
    if (text.includes(from)) text = text.split(from).join(to);
  }

  // 剥等号左侧的固定写法（有界规范化，见文件头说明）
  const beforeAssignment = text;
  text = text.replace(ASSIGNMENT_PREFIX, '').trim();
  if (text !== beforeAssignment) notes.push('已剥掉等号左侧的固定写法');

  if (text.includes('=')) {
    return { ok: false, reason: '表达式里含等号（看起来是方程或关系式，不是表达式）' };
  }
  if (/[<>≤≥≠]/.test(text)) {
    return { ok: false, reason: '表达式里含不等号（关系式不进入符号验证）' };
  }

  /*
   * 顺序有讲究：**先替换无参命令，再展开带参命令**。
   * 反过来的话，`\left(x+1\right)` 会被当成"未登记命令"拒掉（它明明是登记过的）。
   */
  const simplified = applySimpleCommands(text);

  const expanded = expandCommands(simplified);
  if (!expanded.ok) return expanded;

  if (expanded.text.includes('\\')) {
    return { ok: false, reason: '转换后仍残留反斜杠，存在未登记的命令' };
  }

  const trimmed = expanded.text.trim();
  if (trimmed.length === 0) return { ok: false, reason: '转换后表达式为空' };

  const tokenized = checkTokens(trimmed);
  if (!tokenized.ok) return tokenized;

  /*
   * 规范化空白：把运算符/括号/逗号两侧的空格去掉（`2\cdot x` → `2*x`、`x ^ ( 2 )` → `x^(2)`）。
   * 只影响可读性，不改语义；**不**碰运算符之间的空白（`2 x` 是隐式乘法，交给 `mathjs` 解析）。
   */
  const canonical = tokenized.text.replace(/\s*([+\-*/^(),])\s*/g, '$1').trim();
  return { ok: true, expr: canonical, notes };
}
