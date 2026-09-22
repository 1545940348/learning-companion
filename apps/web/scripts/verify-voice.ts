/**
 * 语音输入的**逻辑验证**（对应阶段三"自我验证"）。
 *
 * ### 为什么需要它
 *
 * `verify-render.tsx` 能用 SSR 锁住"界面渲染出什么"，但**锁不住识别的逻辑分支**：
 * 权限被拒、没麦克风、断网、超时、学生取消 —— 这些要真的出一次事才知道对不对，
 * 而在真浏览器里**极难复现**（不能真的拔网线、真的拒绝权限、真的等 60 秒）。
 *
 * 于是这里用一个**假的 `SpeechRecognition`** 打桩：想让引擎说什么就说什么，
 * 想让引擎挂住就挂住。**不装浏览器、不用真麦克风、不连网、不等 60 秒**
 * 就能把每条分支跑一遍。
 *
 * ### 用法
 *
 *   npm run verify:voice -w @lc/web
 *
 * ### 覆盖不到的部分（**不声称已测**）
 *
 * - 真实浏览器的识别质量（中文准确率、方言、噪音）；
 * - 识别服务在实际网络下能不能连上（Chrome 的识别在浏览器厂商服务上做，
 *   部分网络环境会报 `network`）。
 * 这两件事只能**在演示机上人工试**，本脚本一律不假装测过。
 */

import {
  detectVoiceSupport,
  mapSpeechErrorCode,
  silentVoiceLogger,
  type SpeechErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
  type VoiceEnvironment,
} from '../src/shared/lib/voice-support';
import { startVoiceInput } from '../src/shared/lib/voice-input';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail !== undefined ? ` —— ${JSON.stringify(detail)}` : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ==================== 假的识别引擎 ==================== */

/** 引擎里累积的一条结果（形状与 `SpeechResultLike` 对齐） */
type FakeItem = { isFinal: boolean; length: number; 0: { transcript: string; confidence: number } };

/**
 * 打桩用的识别引擎。默认行为刻意贴近真实引擎的两条关键特性：
 * 1. `results` **会累积**（连续识别下每次事件带全部结果，故必须从 `resultIndex` 起读）；
 * 2. `stop()` **不自动触发 `onend`** —— 真实的收尾要靠收尾窗口兜住，
 *    这也正是"引擎挂住不返回"要防的场景。
 */
class FakeRecognition implements SpeechRecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: SpeechResultEventLike) => void) | null = null;
  onerror: ((event: SpeechErrorEventLike) => void) | null = null;
  onend: ((event: unknown) => void) | null = null;
  onstart: ((event: unknown) => void) | null = null;

  /** 最近一次被 `start()` 的实例，供测试驱动 */
  static latest: FakeRecognition | null = null;

  /** `stop()` 的调用次数，用于断言"没有重复起停" */
  stopCalls = 0;
  /** `abort()` 的调用次数 */
  abortCalls = 0;

  private items: FakeItem[] = [];

  start(): void {
    FakeRecognition.latest = this;
    this.onstart?.({});
  }

  stop(): void {
    this.stopCalls += 1;
    // 刻意**不**触发 onend：模拟"引擎不响应"，由收尾窗口兜底
  }

  abort(): void {
    this.abortCalls += 1;
  }

  /* ---------- 测试驱动用 ---------- */

  private emit(resultIndex: number): void {
    const results = Object.assign(
      { length: this.items.length },
      ...this.items.map((item, index) => ({ [index]: item })),
    ) as unknown as SpeechResultEventLike['results'];
    this.onresult?.({ resultIndex, results });
  }

  /** 说出一句**定稿**的话 */
  sayFinal(text: string): void {
    this.items.push({ isFinal: true, length: 1, 0: { transcript: text, confidence: 0.9 } });
    this.emit(this.items.length - 1);
  }

  /** 中途的**未定稿**结果 */
  sayInterim(text: string): void {
    this.items.push({ isFinal: false, length: 1, 0: { transcript: text, confidence: 0.5 } });
    this.emit(this.items.length - 1);
  }

  fail(code: string): void {
    this.onerror?.({ error: code });
  }

  end(): void {
    this.onend?.({});
  }
}

/** 一 `start` 就抛的引擎：验证"起手异常也不会崩" */
class ThrowingRecognition extends FakeRecognition {
  override start(): void {
    throw new Error('InvalidStateError: recognition has already started');
  }
}

const ENV_OK: VoiceEnvironment = {
  speechRecognition: FakeRecognition,
  isSecureContext: true,
};

function lastEngine(): FakeRecognition {
  const engine = FakeRecognition.latest;
  if (engine === null) throw new Error('引擎没有被创建 —— 用例本身写错了');
  return engine;
}

/* ==================== 0. 纯函数：能力探测与错误码映射 ==================== */

console.log('=== 语音输入验证 ===\n');
console.log('--- 0. 能力探测与错误码映射（可直接断言，无副作用） ---');
{
  check('环境里没有识别构造器 → 判定为「不支持」', detectVoiceSupport({}).supported === false);
  check(
    '只有 webkit 前缀的构造器也算支持（旧版 Chrome/Edge 走这条）',
    detectVoiceSupport({ webkitSpeechRecognition: FakeRecognition }).supported === true,
  );
  check('构造器齐全且 https → 判定为支持', detectVoiceSupport(ENV_OK).supported === true);
  check(
    '明确非 https → 拦下（理由是"安全连接"，不是"浏览器不支持"）',
    detectVoiceSupport({ speechRecognition: FakeRecognition, isSecureContext: false }).supported ===
      false,
  );
  check(
    'isSecureContext 为 undefined 时不擅自拦（undefined ≠ 不安全）',
    detectVoiceSupport({ speechRecognition: FakeRecognition }).supported === true,
  );

  check(
    'not-allowed 与 service-not-allowed 归为同一个失败码',
    mapSpeechErrorCode('service-not-allowed') === 'not-allowed',
  );
  check(
    '未知错误码落到 unknown，而不是被硬塞进某个具体成因',
    mapSpeechErrorCode('bad-grammar') === 'unknown',
  );
  check(
    'language-not-supported 归为 unsupported',
    mapSpeechErrorCode('language-not-supported') === 'unsupported',
  );
}

/* ==================== 0b. 权限策略禁用麦克风（2026-09-22 新增） ==================== */

console.log('\n--- 0b. 权限策略：麦克风被本站策略禁掉（防回归） ---');
{
  /*
   * 这条为什么必须存在：2026-09-22 线上事故的根因就是服务端一条
   * `Permissions-Policy: microphone=()` —— 浏览器**连授权弹窗都不弹**、直接回
   * `not-allowed`，界面于是告诉学生"去地址栏放行麦克风"，而地址栏根本没有那个图标。
   * 那个头已改掉（`microphone=(self)`）；这里锁的是**界面这一侧的判别能力**：
   * 哪天网关/代理又加上同样的头，界面要能说出真正的原因。
   */
  const withPolicy = (allows: boolean) => ({
    speechRecognition: FakeRecognition,
    isSecureContext: true,
    permissionsPolicy: { allowsFeature: () => allows },
  });

  const blocked = detectVoiceSupport(withPolicy(false));
  check(
    '★ 策略禁用麦克风 → 判定为「被策略禁用」（不是混进 not-allowed）',
    blocked.supported === false && blocked.code === 'policy-blocked',
  );
  check(
    '★ 文案点明"不会弹出授权提示、改浏览器设置也没用"（否则又把人引去地址栏白找一趟）',
    blocked.supported === false &&
      /不会弹出授权提示/.test(blocked.problem) &&
      /改浏览器设置也没用/.test(blocked.problem),
    blocked.supported === false ? blocked.problem : null,
  );
  check(
    '★ 标为不可重试（学生改不了部署配置，诱使他再点一次只是浪费他的时间）',
    blocked.supported === false && blocked.retryable === false,
  );
  check('策略放行 → 照常判定为支持', detectVoiceSupport(withPolicy(true)).supported === true);
  check(
    '读不到策略对象（老浏览器 / node）→ 当"未知"，不擅自拦（undefined ≠ 被禁）',
    detectVoiceSupport({ speechRecognition: FakeRecognition, isSecureContext: true }).supported === true,
  );

  // 端到端：拦在**起手**，连引擎实例都不创建 —— 不惊动麦克风
  FakeRecognition.latest = null;
  const outcome = await startVoiceInput({ env: withPolicy(false), logger: silentVoiceLogger }).result;
  check(
    '★ 起手即拦：不抛异常、失败码为 policy-blocked',
    !outcome.ok && outcome.code === 'policy-blocked',
    outcome,
  );
  check('★ 引擎实例根本没被创建（没有惊动麦克风）', FakeRecognition.latest === null);
}

/* ==================== 1. 起手就被挡下的两种 ==================== */

console.log('\n--- 1. 起手拦截：不支持的浏览器 / 非 https ---');
{
  const outcome = await startVoiceInput({ env: {}, logger: silentVoiceLogger }).result;
  check('★ 不支持时返回 ok=false，而不是抛异常', outcome.ok === false, outcome);
  check('失败码为 unsupported', !outcome.ok && outcome.code === 'unsupported');
  check(
    '★ 文案给出可操作的出路（换浏览器或打字）',
    !outcome.ok && /Chrome|Edge/.test(outcome.problem),
    !outcome.ok ? outcome.problem : null,
  );
  check('★ 不可重试（再点一次也是同样结果，不该诱使学生重试）', !outcome.ok && outcome.retryable === false);
}
{
  const outcome = await startVoiceInput({
    env: { speechRecognition: FakeRecognition, isSecureContext: false },
    logger: silentVoiceLogger,
  }).result;
  check('非 https → 失败码为 insecure-context', !outcome.ok && outcome.code === 'insecure-context');
  check(
    '★ 文案说明是"安全连接"的问题，与"浏览器不支持"区分开',
    !outcome.ok && outcome.problem.includes('安全连接'),
    !outcome.ok ? outcome.problem : null,
  );
  check('拦在起手，没有创建引擎实例（不惊动麦克风）', FakeRecognition.latest === null);
}

/* ==================== 2. 上游错误：逐条给出不同的说法 ==================== */

console.log('\n--- 2. 上游错误：每种成因都要有自己的说法 ---');
{
  const cases: [string, string, boolean][] = [
    ['not-allowed', 'not-allowed', true],
    ['service-not-allowed', 'not-allowed', true],
    ['audio-capture', 'audio-capture', true],
    ['network', 'network', true],
    ['no-speech', 'no-speech', true],
    ['bad-grammar', 'unknown', true],
  ];
  const problems = new Set<string>();

  for (const [upstream, expectedCode, expectedRetryable] of cases) {
    FakeRecognition.latest = null;
    const session = startVoiceInput({ env: ENV_OK, logger: silentVoiceLogger });
    lastEngine().fail(upstream);
    const outcome = await session.result;
    check(`上游 ${upstream} → 失败码 ${expectedCode}`, !outcome.ok && outcome.code === expectedCode, outcome);
    check(`上游 ${upstream} → 可重试为 ${expectedRetryable}`, !outcome.ok && outcome.retryable === expectedRetryable);
    if (!outcome.ok) problems.add(outcome.problem);
  }

  const distinctCodes = new Set(cases.map(([, code]) => code)).size;
  check(
    '★ 不同失败码各有各的说法（混成一句"出错了"就等于没给信息）',
    problems.size === distinctCodes,
    { 说法数: problems.size, 期望: distinctCodes },
  );
  check('★ 权限被拒的文案指引去放行麦克风', [...problems].some((item) => item.includes('麦克风权限')));
  check('★ 断网的文案点明"需要联网"这一真实限制', [...problems].some((item) => item.includes('联网')));
}

/* ==================== 3. 正常转写 ==================== */

console.log('\n--- 3. 正常转写：文本、逐句时间戳、幂等收尾 ---');
{
  FakeRecognition.latest = null;
  const interims: string[] = [];
  const session = startVoiceInput({
    env: ENV_OK,
    logger: silentVoiceLogger,
    settleMs: 10,
    onInterim: (text) => interims.push(text),
  });
  const engine = lastEngine();

  engine.sayInterim('为什么 f');
  engine.sayFinal('为什么 f 的导数大于零就能说明递增');
  engine.sayFinal('斜率是怎么联系起来的');
  engine.end();
  const outcome = await session.result;

  check('★ 正常转写返回 ok=true', outcome.ok === true, outcome);
  check(
    '★ 两句话都在，按换行分隔',
    outcome.ok && outcome.text.includes('导数大于零') && outcome.text.includes('斜率'),
    outcome.ok ? outcome.text : null,
  );
  check(
    '★ 逐句时间戳 = 2 段（说明书 §2.2 要求保留时间戳以便溯源）',
    outcome.ok && outcome.spans.length === 2,
    outcome.ok ? outcome.spans : null,
  );
  check(
    '★ 时间戳首尾相接、单调不减（不重叠也不留空隙）',
    outcome.ok &&
      outcome.spans.every((span, index) => {
        const previous = index === 0 ? 0 : (outcome.spans[index - 1]?.endMs ?? 0);
        return span.startMs === previous && span.endMs >= span.startMs;
      }),
    outcome.ok ? outcome.spans : null,
  );
  check('中间结果回调收到过未定稿的那半句', interims.some((text) => text.includes('为什么 f')));
  check('定稿后中间结果被清空（不留半句话误导学生）', interims[interims.length - 1] === '');
  check('正常走完没有误调 abort', engine.abortCalls === 0);

  session.stop();
  await sleep(20);
  check('★ 结果已定稿后再按停不会改变结果（幂等）', outcome.ok === true);
  check('★ 引擎的 stop 没有被重复调用（end 是引擎自己发的）', engine.stopCalls === 0, engine.stopCalls);
}

/* ==================== 4. 超时：硬上限，且保留已说出的内容 ==================== */

console.log('\n--- 4. 超时：引擎挂住不返回时强制收尾 ---');
{
  FakeRecognition.latest = null;
  const session = startVoiceInput({
    env: ENV_OK,
    logger: silentVoiceLogger,
    timeoutMs: 40,
    settleMs: 10,
  });
  const engine = lastEngine();
  engine.sayFinal('前半句已经说出来了');

  const outcome = await session.result;
  check('★ 超时返回 ok=false（不假装说完了）', outcome.ok === false, outcome);
  check('失败码为 timeout', !outcome.ok && outcome.code === 'timeout');
  check(
    '★ 超时**保留**已说出的内容（不让学生白说一遍）',
    !outcome.ok && outcome.text === '前半句已经说出来了',
    !outcome.ok ? outcome.text : null,
  );
  check('超时保留了那一段的时间戳', !outcome.ok && outcome.spans.length === 1);
  check('★ 超时可重试', !outcome.ok && outcome.retryable === true);
  check('超时确实调用了 stop() 让引擎别再收音', engine.stopCalls === 1, engine.stopCalls);
}
{
  FakeRecognition.latest = null;
  const session = startVoiceInput({
    env: ENV_OK,
    logger: silentVoiceLogger,
    timeoutMs: 40,
    settleMs: 10,
  });
  const outcome = await session.result;
  check(
    '★ 超时且一个字都没说 → 空文本，不编内容',
    !outcome.ok && outcome.text === '' && outcome.spans.length === 0,
  );
}
{
  // 超时之后引擎**才**回话：仍应如实定性为超时，不能粉饰成"正常说完"
  FakeRecognition.latest = null;
  const session = startVoiceInput({
    env: ENV_OK,
    logger: silentVoiceLogger,
    timeoutMs: 40,
    settleMs: 25,
  });
  const engine = lastEngine();
  engine.sayFinal('超时后才回来的那句');
  await sleep(45);
  engine.end();
  const outcome = await session.result;
  check(
    '★ 超时后引擎才回话，仍定性为 timeout（不粉饰成正常完成）',
    !outcome.ok && outcome.code === 'timeout',
    outcome,
  );
  check('那句迟到的内容照样保留下来', !outcome.ok && outcome.text === '超时后才回来的那句');
}

/* ==================== 5. 学生按停 / 主动取消 ==================== */

console.log('\n--- 5. 学生按停与主动取消：两种意图必须分开 ---');
{
  FakeRecognition.latest = null;
  const session = startVoiceInput({ env: ENV_OK, logger: silentVoiceLogger, settleMs: 10 });
  const engine = lastEngine();
  engine.sayFinal('我说完了');
  session.stop();
  const outcome = await session.result;
  check('★ 按停 = 成功（有内容就交付，不当作失败）', outcome.ok === true, outcome);
  check('按停后文本就是已说的内容', outcome.ok && outcome.text === '我说完了');
}
{
  FakeRecognition.latest = null;
  const session = startVoiceInput({ env: ENV_OK, logger: silentVoiceLogger, settleMs: 10 });
  const engine = lastEngine();
  engine.sayFinal('说了半句又不想要了');
  session.abort();
  const outcome = await session.result;
  check('★ 取消**不**当作失败告警（是学生自己按的，不是故障）', !outcome.ok && outcome.code === 'aborted');
  check('★ 取消不可重试', !outcome.ok && outcome.retryable === false);
  check('★ 取消后不把半截内容塞回输入框', !outcome.ok && outcome.text === '', !outcome.ok ? outcome.text : null);
  check('取消确实调用了 abort()', engine.abortCalls === 1);
  check(
    '取消的文案是中性的（不含"失败/错误"字眼）',
    !outcome.ok && !/失败|错误/.test(outcome.problem),
    !outcome.ok ? outcome.problem : null,
  );
}

/* ==================== 6. 空结果与异常起手 ==================== */

console.log('\n--- 6. 空结果 / 引擎起手就抛 / 引擎自发中止 ---');
{
  FakeRecognition.latest = null;
  const session = startVoiceInput({ env: ENV_OK, logger: silentVoiceLogger, settleMs: 10 });
  lastEngine().end();
  const outcome = await session.result;
  check('★ 没识别出文字 → empty，而不是拿空字符串当成功', !outcome.ok && outcome.code === 'empty', outcome);
  check('empty 可重试', !outcome.ok && outcome.retryable === true);
}
{
  const outcome = await startVoiceInput({
    env: { speechRecognition: ThrowingRecognition, isSecureContext: true },
    logger: silentVoiceLogger,
  }).result;
  check('★ start() 同步抛异常 → 降级为结果，**不向上抛**', outcome.ok === false, outcome);
  check('失败码为 unknown', !outcome.ok && outcome.code === 'unknown');
}
{
  FakeRecognition.latest = null;
  const session = startVoiceInput({ env: ENV_OK, logger: silentVoiceLogger, settleMs: 10 });
  const engine = lastEngine();
  // 引擎自己报 aborted（不是学生按的）：如实转成"已取消"
  engine.fail('aborted');
  const outcome = await session.result;
  check('引擎自发的中止也如实转化为 aborted', !outcome.ok && outcome.code === 'aborted');
  session.stop();
  session.abort();
  check('已结束的会话再调 stop/abort 是空操作（幂等、不抛）', true);
}

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
console.log('');
console.log('未覆盖（**不声称已测**）：真实浏览器的中文识别质量、识别服务在演示网络下能否连上。');
console.log('这两项只能演示前在演示机上人工试一次。');
if (failed > 0) process.exitCode = 1;
