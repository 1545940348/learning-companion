/**
 * 错题归因（`P-B9`，2026-09-23）—— B 负责
 *
 * ### 这条验收为什么难做
 *
 * `todo.md` 对 `P-B9` 的判据是：
 * **四类归因各有可复现样例；须给出可核对理由，不得仅凭答案对错断言。**
 *
 * 后半句是**红线**，不是风格要求。看一眼"选错了"就知道学生错在概念还是算错 ——
 * 这是做不到的；换成让模型看图说话也解决不了：模型的理由**同样不可核对**，
 * 只是把编造换了个来源。
 *
 * ### 因此这里只用**可复算**的依据
 *
 * 学生的选项本身就是最强的证据，而且它是**可以当场核对**的：
 *
 * | 层 | 依据 | 为什么可核对 |
 * |---|---|---|
 * | ① `option-tag` | 干扰项上**人工预标注**的错因 | 理由就是那条标注，逐条可查；标注与题目同源 |
 * | ② `structural` | 所选与正确选项之间的**集合关系**（区间包含） | 结论是一次**包含判定**，不是一次对心思的猜测 |
 * | ⛔ | 上面两层都拿不到 | **返回 `null`，如实说"无法归因"** |
 *
 * ### ⚠️ 被否决的两层（写在这里，防止后来者"顺手补上"）
 *
 * 1. **诊断 Agent（模型）**：模型给的理由无法核对，与 `P-B9` 自己的验收判据冲突。
 *    少一层猜测，比多一层听起来合理的解释更符合这条待办的本意。
 * 2. **数值的倍数／反号推导**（"你选的 6 正好是正确答案 12 的一半 ⇒ 计算错误"）：
 *    **实测反例**就摆在自编题里 —— `fx-der-3` 的正确答案是 `12`、干扰项是 `6`，
 *    而选 `6` 的真实原因是**忘了把 x = 2 代进去**，不是"除以 2 算错"。
 *    选择题的选项本来就是一组简单数，倍数关系**大多是巧合**；
 *    据此断言归因正是 `P-B9` 要禁的"仅凭答案对错断言"。**已删除**。
 *
 * 本模块是**纯函数**：不调模型、不读文件、不访问网络，因此能被 `verify:all` 直接覆盖。
 */

import type {
  MisconceptionKind,
  QuizAttribution,
  QuizItem,
  QuizOption,
} from '@lc/contracts';

/* ==================== 区间解析 ==================== */

/** 一个区间端点。`null` 表示该侧无界（±∞） */
type Bound = number | null;

interface Interval {
  lo: Bound;
  loOpen: boolean;
  hi: Bound;
  hiOpen: boolean;
}

/** 把教材里各种写法下的正负号、无穷统一成 ASCII，便于解析 */
function normalizeMathText(text: string): string {
  return (
    text
      .replace(/[−–—－]/g, '-') // − – — － → -
      .replace(/∞/g, 'inf')
      .replace(/\s+/g, '')
      // `+∞` 是教材里最常见的写法之一（`fx-mon-1` 的正确答案就写着 `(1, +∞)`），
      // 而 `+` 在区间里不携带信息（`+1` 与 `1` 是同一个端点）⇒ 一并去掉。
      // 少了这一步，带 `+` 的选项会解析失败并**静默**退化成"无法归因"。
      .replace(/\+/g, '')
      .trim()
  );
}

/**
 * 解析**单个**区间，如 `(-1,1)`、`(-inf,-1]`、`[0,inf)`。
 *
 * 解析不出来返回 `null` —— 调用方据此放弃推导，**不做猜测性修复**。
 */
function parseInterval(raw: string): Interval | null {
  const match = /^([([])(.+?),([^,]+?)([)\]])$/.exec(raw);
  if (!match) return null;

  const [, openBracket = '(', rawLo = '', rawHi = '', closeBracket = ')'] = match;
  const parseBound = (value: string): Bound | undefined => {
    if (value === 'inf' || value === '-inf') return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return undefined;
  };

  const lo = parseBound(rawLo);
  const hi = parseBound(rawHi);
  if (lo === undefined || hi === undefined) return null;

  return {
    lo,
    loOpen: openBracket === '(',
    hi,
    hiOpen: closeBracket === ')',
  };
}

/**
 * 解析区间的**并集**表达式。
 *
 * 只认顶层分隔符 `与` / `∪` / `,` —— 逗号在 `(1,inf)` 里是区间内部的，
 * 所以按**括号深度**切分，而不是直接 `split(',')`（后者会把 `(1,inf)` 劈成两半）。
 */
function parseIntervalUnion(raw: string): Interval[] | null {
  const text = normalizeMathText(raw);
  if (text.length === 0) return null;

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && '与∪,'.includes(ch)) {
      if (current.length > 0) parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);

  const intervals: Interval[] = [];
  for (const part of parts) {
    const parsed = parseInterval(part);
    if (!parsed) return null;
    intervals.push(parsed);
  }
  return intervals.length > 0 ? intervals : null;
}

/**
 * `outer` 是否完整盖住 `inner`。
 *
 * 端点相同处要**比较开闭**：`(-1,1)` 盖不住 `[-1,1]`（少了两个端点）。
 */
function intervalCovers(outer: Interval, inner: Interval): boolean {
  const lowerOk =
    outer.lo === null ||
    (inner.lo !== null &&
      (outer.lo < inner.lo || (outer.lo === inner.lo && (!outer.loOpen || inner.loOpen))));
  const upperOk =
    outer.hi === null ||
    (inner.hi !== null &&
      (outer.hi > inner.hi || (outer.hi === inner.hi && (!outer.hiOpen || inner.hiOpen))));
  return lowerOk && upperOk;
}

function unionCovers(outer: Interval[], inner: Interval[]): boolean {
  return inner.every((piece) => outer.some((cover) => intervalCovers(cover, piece)));
}

function sameIntervals(a: Interval[], b: Interval[]): boolean {
  return unionCovers(a, b) && unionCovers(b, a);
}

/* ==================== 归因主体 ==================== */

export interface AttributeQuizInput {
  item: QuizItem;
  /** 学生实际选中的选项 id */
  selectedOptionId: string;
}

function findOption(item: QuizItem, optionId: string): QuizOption | undefined {
  return item.options.find((option) => option.id === optionId);
}

/** 组装证据 —— **每一层都必须带上它**，否则这条归因就不该返回 */
function buildEvidence(selected: QuizOption, correct: QuizOption): QuizAttribution['evidence'] {
  return {
    selectedOptionId: selected.id,
    selectedText: selected.text,
    correctOptionId: correct.id,
    correctText: correct.text,
  };
}

/**
 * 层 ②：由「所选区间 vs 正确区间」的**集合关系**归因。
 *
 * 只说**答案本身**的性质（"你的区间是正确答案的真子集"），
 * 不猜学生脑子里发生了什么 —— 这句话学生拿两个区间一比就能核对。
 *
 * ⚠️ 刻意**不做**「两区间不相交 ⇒ 概念误解」：两个不相交的区间既可能是概念混了、
 * 也可能是看错了题，分不开就不断言。那类题靠层 ① 的预标注覆盖。
 */
function attributeByStructure(
  selected: QuizOption,
  correct: QuizOption,
): Omit<QuizAttribution, 'evidence'> | null {
  const selectedIntervals = parseIntervalUnion(selected.text);
  const correctIntervals = parseIntervalUnion(correct.text);
  if (!selectedIntervals || !correctIntervals) return null;
  if (sameIntervals(selectedIntervals, correctIntervals)) return null;

  const selectedSubset = unionCovers(correctIntervals, selectedIntervals);
  const selectedSuperset = unionCovers(selectedIntervals, correctIntervals);
  if (!selectedSubset && !selectedSuperset) return null;

  return {
    kind: 'condition-omission',
    /* `pattern` 是**定值**，不是从理由里摘出来的摘要 —— 只有两种取值，
       因此同类错误跨题累计得到的就是同一个键（见契约 `QuizOption.misconception.pattern`） */
    pattern: selectedSubset ? '区间写窄了（漏段或漏端点）' : '区间写宽了（多写了不成立的部分）',
    reason: selectedSubset
      ? '你选的区间是正确答案的**真子集**：题目条件还在一段你没写出来的区间上成立，你漏掉了那一部分（或漏掉了端点）。'
      : '你选的区间**多包含了**一部分：题目条件在你写出的这部分区间之外并不成立。',
    basis: 'structural',
    verification: 'symbolic',
  };
}

/**
 * 归因入口。
 *
 * 返回 `null` 的含义是**「无法归因」**，不是"没错" —— 调用方必须把这两种情况分开说
 * （见 `QuizPanel` 的文案）：把"推不出来"说成"你已经掌握"同样是失真。
 *
 * @returns 归因结论；答对、选项不存在、或两层都推不出时返回 `null`
 */
export function attributeQuizAttempt(input: AttributeQuizInput): QuizAttribution | null {
  const { item, selectedOptionId } = input;
  if (typeof item.answer !== 'string' || item.answer.length === 0) return null;

  // 答对了不归因：归因描述的是"错在哪"，对作答正确的情形没有可说的
  if (selectedOptionId === item.answer) return null;

  const selected = findOption(item, selectedOptionId);
  const correct = findOption(item, item.answer);
  // 选项读不到就给不出可核对的证据 —— 宁可返回 null，也不给没有证据的结论
  if (!selected || !correct) return null;

  /* ---------- 层 ①：干扰项预标注（最强，逐条可查） ---------- */
  if (selected.misconception) {
    return {
      kind: selected.misconception.kind,
      pattern: selected.misconception.pattern,
      reason: selected.misconception.reason,
      basis: 'option-tag',
      evidence: buildEvidence(selected, correct),
      // 标注与固定题同源，都是人工核验过的（与 `verification: 'human'` 同一口径）
      verification: 'human',
    };
  }

  /* ---------- 层 ②：结构推导（一次可复算的包含判定） ---------- */
  const structural = attributeByStructure(selected, correct);
  if (structural) {
    return { ...structural, evidence: buildEvidence(selected, correct) };
  }

  /* ---------- 推不出就如实说推不出 ---------- */
  return null;
}

/** 四类归因的取值全集，供调用方校验（与契约 `MisconceptionKind` 同集合） */
export const ATTRIBUTABLE_KINDS: readonly MisconceptionKind[] = [
  'concept-misunderstanding',
  'calculation-error',
  'condition-omission',
  'recognition-error',
];
