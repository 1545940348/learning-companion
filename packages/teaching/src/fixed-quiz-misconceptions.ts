/**
 * 自编题干扰项的**错因标注表**（`P-B9`，2026-09-23）
 *
 * ### 这是什么
 *
 * 键 `"<题目 id>:<选项 id>"` → 一条人工写下的错因。它是错题归因里**最强的一层依据**：
 * 理由不是答错后由模型现编的，而是**出题时就写下的**，因此逐条可核（见 `attribution.ts`）。
 *
 * ### 为什么单独一个文件
 *
 * 两者由**不同的判据**维护，放在一起会互相绊住：
 * - `fixed-quiz.ts` 是**数学内容**（题干、选项、答案、解析）—— B 初审、A 依据核验清单复核；
 * - 本文件是**归因依据**—— 只由 B 维护，改动不影响题面。
 *
 * 分开还有个直接好处：`verify:file-size` 的阈值是 300 行，合写会多出一个超限文件（`I43`）。
 *
 * ### 标注写的是什么
 *
 * 写的是**这个干扰项被设计来捕捉什么**（命题意图），不是在推断学生脑子里发生了什么。
 * 学生选了它，说明他很可能落进了这个设计好的坑里。
 * 凡涉及"等于什么"的地方都给出**可当场验算的等式或事实**——
 * 这正是 `P-B9` 要求的"可核对理由"，也是它禁止的"仅凭答案对错断言"的反面。
 *
 * ### `pattern`：画像累计用的短名字
 *
 * 每条除了 `reason`（逐题的完整句）还有 `pattern`（跨题稳定的短名字）。
 * **同一个坑在相关题目上复用同一个 `pattern`** —— 这是画像 `count` 能真的数出
 * "同一个坑踩了几次"的前提。本表里刻意埋了几组复用，可当场核对：
 *
 * | `pattern` | 出现在 | 累计上限 |
 * |---|---|---|
 * | 把导数符号与单调性对应关系记反 | `fx-mon-1:A`、`fx-mon-2:A`、`fx-mon-3:B`、`fx-mon-3:C` | 4 |
 * | 把函数值当导数值 | `fx-der-1:A`、`fx-tan-3:A` | 2 |
 * | 求出导函数就以为求出了某点的导数 | `fx-der-3:A` | 1 |
 *
 * 反过来，**相近但不同的坑刻意用不同的词**（`把函数值当导数值` 与
 * `把切点坐标当成斜率` 是两回事）—— 用同一个词会把两个坑并成一个，且看不出来。
 *
 * ### 四类的可复现样例（验收判据：「四类归因各有可复现样例」）
 *
 * | 类别 | 样例（题目:选项） |
 * |---|---|
 * | 概念误解 `concept-misunderstanding` | `fx-der-1:A`（把函数值当导数值）、`fx-mon-1:A`（递增递减取反） |
 * | 计算错误 `calculation-error` | `fx-der-1:D`（把导数取成倒数）、`fx-tan-2:B`（常数项符号） |
 * | 条件遗漏 `condition-omission` | `fx-der-3:A`（漏掉"在 x=2 处"）、`fx-tan-2:D`（漏掉"过切点"） |
 * | 识别错误 `recognition-error` | `fx-der-2:A`（把 Δx→0 当成结果为 0）、`fx-tan-3:D`（导数认成倒数） |
 *
 * ⚠️ **每道题的每个干扰项都要有标注**（共 27 条）——没有标注的干扰项会让归因落在
 * 「无法归因」上，而这是**我们自己出的题**，没有理由推不出来。
 * `verify:all` 的 §15 有一组断言专门检查"27 条标注齐全、键全部命中、
 * 四类各有样例、且每条都带 >= 20 字的可核对理由"。
 */

import type { MisconceptionKind } from '@lc/contracts';

export interface MisconceptionTag {
  kind: MisconceptionKind;
  /** 跨题稳定的短名字，画像按 `kind + pattern` 累计 */
  pattern: string;
  reason: string;
}

export const FIXED_QUIZ_MISCONCEPTIONS: Record<string, MisconceptionTag> = {
  /* ==================== derivative ==================== */

  'fx-der-1:A': {
    kind: 'concept-misunderstanding',
    pattern: '把函数值当导数值',
    reason:
      '1 是**函数值** f(1) = 1² = 1，不是导数值。题目问的是 f′(1)。把 f(a) 与 f′(a) 看成一回事，是导数概念本身没分清。',
  },
  'fx-der-1:C': {
    kind: 'concept-misunderstanding',
    pattern: '把"某点导数为零"当成"处处为零"',
    reason:
      'f′(x) = 2x 只有**在 x = 0 处**才等于 0。本题问的是 x = 1 处，此处 f′(1) = 2。把"某点导数为 0"当成了"处处导数为 0"。',
  },
  'fx-der-1:D': {
    kind: 'calculation-error',
    pattern: '把导数算成了倒数',
    reason:
      '正确答案是 2，而 1/2 恰好是 2 的**倒数**（2 × 1/2 = 1）。这个干扰项捕捉的是求导过程中把 2x 取成倒数的算错 —— 概念没错，最后一步算式错了。',
  },

  'fx-der-2:A': {
    kind: 'recognition-error',
    pattern: '把"趋于零的量"直接当成结果',
    reason:
      '这是**看错题目**：式子里的"Δx 趋于 0"说的是**自变量增量**趋于 0，不是整个分式的值趋于 0。分式化简后是 2 + Δx，它的极限是 2。把"趋于 0 的那个量"直接当成了结果。',
  },
  'fx-der-2:B': {
    kind: 'calculation-error',
    pattern: '展开时漏乘系数',
    reason:
      '展开时漏了一项：(1 + Δx)² = 1 + **2**Δx + Δx²，分子是 2Δx + Δx²。若把分母约分成 1 + Δx，就会得到 1 —— 这是展开环节丢了系数 2。',
  },
  'fx-der-2:D': {
    kind: 'concept-misunderstanding',
    pattern: '把未定式当成极限不存在',
    reason:
      '把"0/0 型未定式"当成了"极限不存在"。Δx → 0 时分子分母都趋于 0，但先化简得 2 + Δx，极限存在且为 2。未定式的意思正是"**要先化简再判断**"。',
  },

  'fx-der-3:A': {
    kind: 'condition-omission',
    pattern: '求出导函数就以为求出了某点的导数',
    reason:
      '6 是**导函数** f′(x) = 6x 的系数，也就是 f′(1)。题目问的是 f′(**2**)，你漏掉了"在 x = 2 处"这个条件 —— 求出导函数并不等于求出了某点的导数值。',
  },
  'fx-der-3:C': {
    kind: 'concept-misunderstanding',
    pattern: '把式子里的系数当成答案',
    reason:
      '3 是原函数 f(x) = 3x² 的**系数**，与导数值无关。f′(x) = 6x，f′(2) = 12。把式子里的常数当成了答案。',
  },
  'fx-der-3:D': {
    kind: 'calculation-error',
    pattern: '代入时多乘了一次',
    reason:
      '24 = 6 × 2 × 2，比正确答案 12 多乘了一个 2 —— 代入 x = 2 时把 6x 里的系数与 x 各乘了一次。是一个可当场验算的乘法环节错误。',
  },

  /* ==================== tangent ==================== */

  'fx-tan-1:A': {
    kind: 'concept-misunderstanding',
    pattern: '把切点坐标当成斜率',
    reason:
      '1 是切点 (1, 1) 的**横坐标**，不是斜率。切线斜率等于该点导数值 y′ = 2x，在 x = 1 处为 2。把点的坐标当成了斜率。',
  },
  'fx-tan-1:C': {
    kind: 'recognition-error',
    pattern: '把"求斜率"读成"问是否水平"',
    reason:
      '这是把"求斜率"**读成了**"问这条切线是不是水平的"。水平切线的斜率才是 0；y = x² 在 (1, 1) 处的斜率为 2，切线并不水平。',
  },
  'fx-tan-1:D': {
    kind: 'calculation-error',
    pattern: '代入时符号处理错',
    reason:
      '−1 等于切点纵坐标 1 取了负号。斜率应当是 y′ = 2x 在 x = 1 处的值，即 2；−1 是代入过程中符号处理错了。',
  },

  'fx-tan-2:B': {
    kind: 'calculation-error',
    pattern: '展开时常数项符号弄反',
    reason:
      '斜率 2 用对了。把点 (1, 1) 代入点斜式 y − 1 = 2(x − 1) 展开应得 y = 2x **−** 1；写成 +1 是把常数项的符号弄反了（验算：x = 1 时 y = 3 ≠ 1，而切线必须过 (1, 1)）。',
  },
  'fx-tan-2:C': {
    kind: 'concept-misunderstanding',
    pattern: '把斜率取成了 1',
    reason:
      '切线斜率是导数值 2，不是 1。y = x 的斜率为 1 —— 这条直线只是恰好过原点，与切点处的导数无关。',
  },
  'fx-tan-2:D': {
    kind: 'condition-omission',
    pattern: '漏掉"直线过切点"这个条件',
    reason:
      '你只用了「斜率为 2」这一个条件，**漏掉了「直线过切点 (1, 1)」**。验算：x = 1 时 y = 2 ≠ 1，所以 y = 2x 并不过 (1, 1)，不是这条切线。',
  },

  'fx-tan-3:A': {
    kind: 'concept-misunderstanding',
    pattern: '把函数值当导数值',
    reason:
      'f(a) 是切点的**纵坐标**（函数值），不是斜率。斜率是导数 f′(a)。把函数值与导数值混为一谈。',
  },
  'fx-tan-3:C': {
    kind: 'calculation-error',
    pattern: '把"在某点求值"当成了"对 a 做除法"',
    reason:
      '多除了一次 a。斜率就是 f′(a) 本身，不需要再对 a 做运算 —— 这是把"在 x = a 处求值"误当成了"对 a 做除法"。',
  },
  'fx-tan-3:D': {
    kind: 'recognition-error',
    pattern: '把"导数"看成"倒数"',
    reason:
      '把**导数**认成了**倒数**。f′(a) 与 1 / f′(a) 只有在 f′(a) = ±1 时才相同，一般并不相等；这一项捕捉的是把"导"与"倒"两个字看混。',
  },

  /* ==================== monotonicity ==================== */

  'fx-mon-1:A': {
    kind: 'concept-misunderstanding',
    pattern: '把导数符号与单调性的对应关系记反',
    reason:
      '(−1, 1) 是**递减**区间（这一段上 f′(x) = 3(x − 1)(x + 1) < 0）。把导数符号与单调性的对应关系取反了。',
  },
  'fx-mon-1:C': {
    kind: 'concept-misunderstanding',
    pattern: '把转折点两侧连成一片',
    reason:
      '把 x = −1 **两侧连成了一片**。f′(x) 在 (−1, 1) 上取负值，这一段是递减的；递增区间在 x = −1 处断开。',
  },
  'fx-mon-1:D': {
    kind: 'concept-misunderstanding',
    pattern: '把单调性与 x 的正负挂钩',
    reason:
      '把"递增"与"x 为正"挂上了钩 —— 单调性与 x 的正负无关，只与 f′(x) 的符号有关。实际上 x < −1 时（x 为负）f′(x) > 0，也是递增。',
  },

  'fx-mon-2:A': {
    kind: 'concept-misunderstanding',
    pattern: '把导数符号与单调性的对应关系记反',
    reason:
      '导数为**正**对应单调**递增**。这一项捕捉的是把判据记反 —— 验算：f(x) = x 在任意区间上 f′(x) = 1 > 0，而它是递增的。',
  },
  'fx-mon-2:C': {
    kind: 'recognition-error',
    pattern: '题干读漏"恒有"二字',
    reason:
      '"先增后减"需要导数**变号**（由正转负），而题干给的是"在 I 上**恒有** f′(x) > 0" —— 一个不变号的导数不会产生增减转折。题干读漏了"恒有"。',
  },
  'fx-mon-2:D': {
    kind: 'concept-misunderstanding',
    pattern: '以为不知道 f 就无法判断单调性',
    reason:
      '把"不知道 f 的具体表达式"误当成"无法判断单调性"。恰恰相反：f′(x) 的符号**本身就是**判定单调性的依据，恒正即可断定递增，不需要知道 f 长什么样。',
  },

  'fx-mon-3:B': {
    kind: 'concept-misunderstanding',
    pattern: '把导数符号与单调性的对应关系记反',
    reason:
      '(−∞, −1) 上 f′(x) > 0，是**递增**区间。与 fx-mon-1 同一类错误：把导数符号与单调性的对应关系取反了。',
  },
  'fx-mon-3:C': {
    kind: 'concept-misunderstanding',
    pattern: '把导数符号与单调性的对应关系记反',
    reason:
      '(1, +∞) 上 f′(x) > 0，同样是**递增**区间。递减只发生在 f′(x) < 0 的地方，即 (−1, 1)。',
  },
  'fx-mon-3:D': {
    kind: 'condition-omission',
    pattern: '漏掉导数变号的位置',
    reason:
      '把"x < 0"当成了递减区间，**漏掉了"符号在 x = −1 处改变"这个条件**。在 (−∞, −1) 上 f′(x) > 0（递增），递减只从 x = −1 才开始。',
  },
};
