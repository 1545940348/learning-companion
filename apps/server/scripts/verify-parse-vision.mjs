/**
 * 视觉接入（图片 → 文本）验证脚本
 *
 * 对应说明书 §2.1/§2.2（图文输入与识别）、待办 `I6`（多模态解析未接入）、
 * 实现文件 `apps/server/src/parse/vision.ts` 与 `parse/capabilities.ts`。
 *
 * ### 这个脚本要证明的五件事（都做成**有分辨力**的断言）
 *
 * 1. **格式判定看内容、不看客户端声明** —— 同一段 PNG 字节，声明成 `image/jpeg`
 *    仍必须判为 PNG。一个"照抄请求头"的实现过不了这条。
 * 2. **体积闸门是按字节、不是按 base64 字符数** —— 恰好超限的图必须被拒。
 * 3. **不编造数据** —— 定位不到正文的公式/低置信度片段必须**被丢掉**，
 *    而不是塞一个假偏移（`start:0,end:0`）。
 * 4. **`notToScale` 真的会丢数值** —— 契约明文要求"无刻度示意图不得估算数值"。
 * 5. **模型返回不可解析时不抛异常** —— 降级为纯文本 + 一条低置信度说明，
 *    保证一次格式异常不会把请求打成 500（需求：新功能失败不得导致主进程崩溃）。
 *
 * 全部用**注入的假模型函数**，**不消耗模型额度、不联网**。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:vision
 */

import { MATERIAL_LIMITS } from '@lc/contracts';
import { RECOGNITION_CAPABILITIES } from '../src/parse/capabilities.js';
import { VisionInputError, normalizeImage, recognizeImage } from '../src/parse/vision.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail === undefined ? '' : ` —— ${JSON.stringify(detail)}`}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/** 造一段"内容像 PNG"的字节：只有魔数是真的，其余无意义（识别层也只嗅探魔数） */
function fakePng(extraBytes = 32) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extraBytes)]);
}

function fakeJpeg(extraBytes = 32) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extraBytes)]);
}

/** 静默 logger：验证脚本不该往控制台打业务日志（否则看不出哪条断言失败） */
const silentLogger = { info() {}, warn() {}, error() {} };

/** 造一个"永远返回这段文本"的假模型函数，并记录它收到的输入 */
function fixedCaller(text) {
  const calls = [];
  const caller = async (input, options) => {
    calls.push({ input, options });
    return text;
  };
  return { caller, calls };
}

/* ==================== 1. 入参：看内容，不看声明 ==================== */

section('1. 图片载荷校验：格式按内容判定，体积按字节判定');

const pngBase64 = fakePng().toString('base64');

const accepted = normalizeImage(pngBase64);
check('★ 合法 PNG 被接受', accepted.mediaType === 'image/png', accepted.mediaType);
check('★ 产出的 base64 不含 data URI 前缀', !accepted.dataBase64.startsWith('data:'), accepted.dataBase64.slice(0, 12));
check('字节数与解码结果一致', accepted.bytes === fakePng().length, accepted.bytes);

const withPrefix = normalizeImage(`data:image/png;base64,${pngBase64}`);
check('★ 容忍 data URI 前缀并剥离', withPrefix.mediaType === 'image/png' && !withPrefix.dataBase64.includes(','));

// 关键负例：声明与内容不一致时，以**内容**为准（这条会打一条 warn，故注入静默 logger）
const lyingJpeg = normalizeImage(`data:image/jpeg;base64,${pngBase64}`, silentLogger);
check('★ 声明 jpeg、内容 png → 判为 png（不信任声明）', lyingJpeg.mediaType === 'image/png', lyingJpeg.mediaType);

check('JPEG 魔数被识别', normalizeImage(fakeJpeg().toString('base64')).mediaType === 'image/jpeg');

function expectInputError(label, fn) {
  try {
    fn();
    check(label, false, '未抛错');
  } catch (error) {
    check(label, error instanceof VisionInputError, error?.name);
  }
}

expectInputError('空字符串被拒', () => normalizeImage(''));
expectInputError('非 base64 字符被拒', () => normalizeImage('这不是base64!!'));
expectInputError('合法 base64 但非图片内容被拒', () => normalizeImage(Buffer.from('hello world').toString('base64')));

// 体积闸门：恰好超过 1 字节就必须拒 —— 证明判的是**字节**而不是 base64 字符数
const oversize = fakePng(MATERIAL_LIMITS.maxImageBytes);
expectInputError(
  `超过 ${Math.round(MATERIAL_LIMITS.maxImageBytes / 1024 / 1024)} MB 被拒（按字节）`,
  () => normalizeImage(oversize.toString('base64')),
);

/* ==================== 2. 正常识别：字段落位与"不编造" ==================== */

section('2. 正常识别：结构化字段、公式定位、不编造数据');

const happyJson = JSON.stringify({
  text: '判断 f(x)=x^{3}-3x 的单调性，先求 f\'(x)。',
  imageDescription: '一道关于单调性的题目',
  imageStructure: { chartType: '无', trend: '先增后减再增' },
  formulas: ['f(x)=x^{3}-3x', '这条公式在正文里并不存在'],
  lowConfidence: [
    { text: '先求 f\'(x)', reason: '该处笔迹较淡' },
    { text: '这段文字正文里没有', reason: '不该出现' },
  ],
});

const happy = await recognizeImage(accepted, { caller: fixedCaller(happyJson).caller, logger: silentLogger });

check('文本被采用', happy.text.includes('x^{3}-3x'), happy.text);
check('图片描述落位', happy.imageDescription === '一道关于单调性的题目');
check('结构化理解落位', happy.imageStructure?.trend === '先增后减再增', happy.imageStructure);

check('★ 能定位到的公式被保留', happy.formulas?.length === 1, happy.formulas);
check(
  '★ 定位不到的公式被丢弃（不写假偏移）',
  (happy.formulas ?? []).every((f) => happy.text.slice(f.start, f.end).includes('x^{3}-3x')),
  happy.formulas,
);
check('★ 能定位到的低置信度片段被保留', happy.lowConfidence.length === 1, happy.lowConfidence);
check(
  '★ 低置信度偏移指向正文内的真实片段',
  happy.lowConfidence.every((s) => s.end <= happy.text.length && s.start < s.end),
  happy.lowConfidence,
);
check(
  '★ 定位不到的片段没有被编造成 0 偏移',
  !happy.lowConfidence.some((s) => s.start === 0 && s.end === 0),
  happy.lowConfidence,
);

/* ==================== 3. 无刻度示意图：不得估算数值 ==================== */

section('3. 无刻度示意图：notToScale 必须丢掉数值型关键点');

const notToScaleJson = JSON.stringify({
  text: '示意函数图像',
  imageStructure: {
    notToScale: true,
    keyPoints: [
      { label: '极大值点', x: 99, y: 99 },
      { label: '极小值点', x: -99, y: -99 },
    ],
  },
});

const scaled = await recognizeImage(accepted, { caller: fixedCaller(notToScaleJson).caller, logger: silentLogger });
check('notToScale 被保留', scaled.imageStructure?.notToScale === true);
check(
  '★ 数值被丢弃、label 保留（契约明文要求）',
  (scaled.imageStructure?.keyPoints ?? []).every((p) => p.x === undefined && p.y === undefined && p.label),
  scaled.imageStructure?.keyPoints,
);

/* ==================== 4. 降级与失败：不崩、不吞 ==================== */

section('4. 模型返回不可解析时降级；模型失败原样抛出');

const degraded = await recognizeImage(accepted, {
  caller: fixedCaller('这是一段没有 JSON 的普通文字，模型没听格式要求。').caller,
  logger: silentLogger,
});
check('★ 不抛异常，按纯文本采用', degraded.text.includes('没有 JSON'), degraded.text);
check('★ 如实标注降级原因', degraded.lowConfidence.some((s) => s.reason.includes('结构化格式')), degraded.lowConfidence);

let emptyTextRejected = false;
try {
  await recognizeImage(accepted, { caller: fixedCaller(JSON.stringify({ text: '   ' })).caller, logger: silentLogger });
} catch (error) {
  emptyTextRejected = error instanceof VisionInputError;
}
check('★ 识别结果为空文本时给出可操作的 400 级错误', emptyTextRejected);

class FakeUpstreamError extends Error {}
let propagated = null;
try {
  await recognizeImage(accepted, {
    caller: async () => {
      throw new FakeUpstreamError('上游 503');
    },
    logger: silentLogger,
  });
} catch (error) {
  propagated = error;
}
check('★ 模型侧错误原样抛出（不在此处吞掉）', propagated instanceof FakeUpstreamError, propagated?.message);

/* ==================== 5. 学生同时给了文字：不能丢 ==================== */

section('5. 学生自己写的字必须保留，且偏移仍然正确');

const withHint = await recognizeImage(accepted, {
  hint: '这是第二章的例题',
  caller: fixedCaller(happyJson).caller,
  logger: silentLogger,
});
check('★ 学生输入出现在正文里（不静默丢弃）', withHint.text.startsWith('这是第二章的例题'), withHint.text.slice(0, 20));
check(
  '★ 加了前缀之后，公式偏移仍指向真实位置',
  (withHint.formulas ?? []).every((f) => withHint.text.slice(f.start, f.end).includes('f(x)')),
  withHint.formulas,
);
check(
  '★ 加了前缀之后，低置信度偏移仍指向真实位置',
  withHint.lowConfidence.every((s) => withHint.text.slice(s.start, s.end).length > 0),
  withHint.lowConfidence,
);

/* ==================== 6. 能力上报：如实 ==================== */

section('6. /api/health 的能力声明必须与实现一致');

check('图片通道声明为可用', RECOGNITION_CAPABILITIES.image.available === true);
check('★ 语音通道声明为**不可用**（服务端不转写，与 D3 一致）', RECOGNITION_CAPABILITIES.audio.available === false);
check('语音的说明里写明识别不在服务端', RECOGNITION_CAPABILITIES.audio.note.includes('浏览器'), RECOGNITION_CAPABILITIES.audio.note);
check('两个通道都带了给人看的边界说明', RECOGNITION_CAPABILITIES.image.note.length > 0 && RECOGNITION_CAPABILITIES.audio.note.length > 0);

/* ==================== 汇总 ==================== */

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
