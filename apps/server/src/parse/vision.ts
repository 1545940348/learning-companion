/**
 * 图片识别（`POST /api/parse` 的视觉路径）。
 *
 * ### 这一层在做什么
 *
 * 把学生上传的讲义图片交给**已接入的模型通道**，取回三样东西：
 * 1. **文本** —— 后续与"学生手打文字"走**完全相同**的下游管道
 *    （材料 → 图谱 → 缺口），因此下游一个字都不用改；
 * 2. **图片的描述与结构化理解**（图表类型 / 坐标轴 / 关键点 / 趋势）；
 * 3. **公式 LaTeX**（供符号验证与展示）。
 *
 * ### 分工（与 `vision-output.ts` 的边界）
 *
 * 本文件管"**怎么把图送出去**"：载荷校验、调用模型、错误口径。
 * `vision-output.ts` 管"**怎么把回的东西读懂**"：JSON 提取、字段校验、
 * 偏移定位、`notToScale` 规则。换通道动这里，改字段规范动那里。
 *
 * ### 为什么不需要改契约
 *
 * `ParseResponse` 早已预留 `text / formulas / imageDescription / imageStructure /
 * lowConfidence / unavailable` 全部字段（`packages/contracts/src/api.ts`）；
 * 图片内容块 `{type:'image', mediaType, dataBase64}` 也已由教学层
 * （`packages/teaching/src/model.ts`）与两条适配器实现并实测通过
 * （2026-09-17 实测：DS 图片调用 3195 ms，正确转写 `f(x)=x³−3x` 与临界点 `x=±1`）。
 * **本模块只负责「接线 + 防御」**，不引入任何新的数据结构。
 *
 * ### 防御约定（对需求「边界防御」的逐条落点）
 *
 * - **入参**：大小与格式在本模块校验，且**不信任客户端声明的媒体类型** ——
 *   改用**魔数嗅探**（PNG `89 50 4E 47` / JPEG `FF D8 FF`）。不合法抛
 *   `VisionInputError`，由路由层转 400；**本模块不含任何 HTTP 概念**（便于单测）。
 * - **超时 / 重试 / 日志**：复用 `model/budget.ts` 的 `withBudget` ——
 *   它已实现单请求总预算、受控重试（仅 `UPSTREAM` 可重试）并记录
 *   `model.call.start/ok`。本模块**不自己发网络请求**，只经注入的 `ModelCaller`，
 *   因此"超时控制 + 规范日志"是**继承来的**，不是另起一套。
 * - **模型返回不可解析**：**不抛异常**。降级为"按纯文本采用"并记一条
 *   `lowConfidence`，保证一次格式异常不会让整个请求崩成 500。
 * - **不编造数据**：见 `vision-output.ts` 的两条硬纪律。
 *
 * ### 载荷约束（本项目的"形状标注"）
 *
 * 本项目**没有张量**（不含深度学习层）。此处的"大块数据"是图片的 base64 文本，
 * 其约束与张量 shape 同等重要，故逐项写死在此并校验：
 * **格式仅 `image/png` / `image/jpeg`；单张 ≤ `MATERIAL_LIMITS.maxImageBytes`（5 MB）；
 * 载荷为不含 data URI 前缀的原始 base64（`data:` 前缀会被容忍并剥离）。**
 */

import { MATERIAL_LIMITS, type FormulaSpan, type ImageStructure, type LowConfidenceSpan } from '@lc/contracts';
import type { ModelCaller, ModelInputBlock } from '@lc/teaching';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { interpretModelOutput } from './vision-output.js';

/** 允许的图片格式（说明书 2.1：仅 PNG / JPEG） */
type AllowedMediaType = 'image/png' | 'image/jpeg';

/** 输入不合法（大小 / 格式 / 编码）。**由路由层转成 400**，本模块不碰 HTTP。 */
export class VisionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionInputError';
  }
}

/** 校验并归一化后的图片载荷 */
export interface NormalizedImage {
  /** 由**魔数嗅探**得出，不是客户端声明的值 */
  mediaType: AllowedMediaType;
  /** 不含 data URI 前缀的原始 base64 */
  dataBase64: string;
  /** 解码后的字节数（用于体积判定与日志） */
  bytes: number;
}

/** 一次图片识别的结果，字段与 `ParseResponse` 对齐（可直接展开进响应） */
export interface VisionResult {
  text: string;
  imageDescription?: string;
  imageStructure?: ImageStructure;
  formulas?: FormulaSpan[];
  lowConfidence: LowConfidenceSpan[];
}

export interface RecognizeOptions {
  /**
   * 学生同时给出的文字（可空）。
   *
   * 两件事同时发生，都是为了**不静默丢内容**（`I14` 的教训）：
   * 1. 作为**识别提示**送给模型，帮助它更准地理解图片；
   * 2. 作为**材料正文的前缀**保留下来，学生写的字不会因为"传了图"而消失。
   *
   * 由于前缀是在**定位公式/低置信度之前**拼进正文的（在 `vision-output.ts` 内），
   * `start/end` 天然仍指向最终正文 —— 不需要额外的偏移换算。
   */
  hint?: string;
  caller: ModelCaller;
  logger?: Logger;
}

/**
 * 视觉识别用的系统提示词。
 *
 * 两条规则直接来自说明书 §2.2，写进提示词是为了**从源头减少不可靠输出**：
 * - **看不清就不许猜** —— 不确定的片段必须进 `lowConfidence`；
 * - **无刻度示意图不得估算数值** —— `notToScale` 置真且不给数值型关键点。
 */
const VISION_SYSTEM_PROMPT = [
  '你是一个讲义图片识别器。只做**转写与结构化**，不做讲解、不补充知识、不推断答案。',
  '',
  '输出**一个 JSON 对象**，不要任何解释文字、不要 Markdown 代码围栏，字段如下：',
  '{',
  '  "text": "把图片内容完整转写为可继续学习的文本。公式写成 LaTeX 行内形式，如 $f(x)=x^{3}-3x$。保留题号、条件与问句的原有措辞。",',
  '  "imageDescription": "一句话说明这是什么（讲义片段 / 题目 / 函数图像 / 表格）。",',
  '  "imageStructure": { "chartType": "函数图像|示意图|表格|无", "axes": {"x":"","y":""}, "keyPoints": [{"label":"","x":0,"y":0}], "trend": "", "notToScale": false },',
  '  "formulas": ["f(x)=x^{3}-3x", "f\'(x)=3x^{2}-3"],',
  '  "lowConfidence": [ { "text": "看不清的片段原文", "reason": "为什么不确定" } ]',
  '}',
  '',
  '硬性要求：',
  '1. **看不清就不许猜。** 模糊、遮挡、被裁掉的片段一律进 `lowConfidence`，不要在 `text` 里编造。',
  '2. **示意图无刻度时，`notToScale` 必须为 `true`，且 `keyPoints` 里不得出现数值**（只写 label）。',
  '3. 图上没有的内容不要补；宁缺毋滥。',
  '4. `formulas` 只放图上真实出现的公式，用 LaTeX；没有就给空数组。',
].join('\n');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** 剥离 `data:*;base64,` 前缀，返回声明类型（可能为 null）与纯 base64 */
function stripDataUrl(raw: string): { declared: string | null; dataBase64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(raw);
  if (!match) return { declared: null, dataBase64: raw };
  return { declared: match[1] ?? null, dataBase64: match[2] ?? '' };
}

/** 按魔数判断真实格式；不认识则返回 null */
function sniffMediaType(bytes: Buffer): AllowedMediaType | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return 'image/jpeg';
  return null;
}

/**
 * 校验并归一化图片载荷。任何不合法情形都抛 `VisionInputError`（带**具体原因**）。
 *
 * `logger` 可注入，与 `recognizeImage` 保持一致 —— 验证脚本要能在**无噪声**下
 * 断言（否则业务日志会和断言输出混在一起，看不出哪条失败）。
 */
export function normalizeImage(raw: string, logger: Logger = defaultLogger): NormalizedImage {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new VisionInputError('图片内容为空');
  }

  const { declared, dataBase64 } = stripDataUrl(raw.trim());
  if (!/^[A-Za-z0-9+/=\s]+$/.test(dataBase64)) {
    throw new VisionInputError('图片不是合法的 base64 编码');
  }

  // base64 长度上限先挡一道，避免为一个超大字符串做无谓解码
  const maxBytes = MATERIAL_LIMITS.maxImageBytes;
  if (dataBase64.length > Math.ceil(maxBytes / 3) * 4 + 8) {
    throw new VisionInputError(
      `图片超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB，请压缩后重试`,
    );
  }

  const bytes = Buffer.from(dataBase64.replace(/\s/g, ''), 'base64');
  if (bytes.length === 0) {
    throw new VisionInputError('图片解码后为空');
  }
  if (bytes.length > maxBytes) {
    throw new VisionInputError(
      `图片 ${(bytes.length / 1024 / 1024).toFixed(1)} MB 超过上限 ` +
        `${Math.round(maxBytes / 1024 / 1024)} MB，请压缩后重试`,
    );
  }

  const sniffed = sniffMediaType(bytes);
  if (sniffed === null) {
    throw new VisionInputError('只支持 PNG 或 JPEG 图片（按文件内容判断）');
  }
  // 客户端声明的类型与真实内容不一致时**以内容为准**并记下来：
  // 这是"不要信客户端"的落点，也能解释上游为何可能拒收。
  if (declared !== null && declared !== sniffed) {
    logger.warn('parse.vision.mediaTypeMismatch', { declared, sniffed });
  }

  return { mediaType: sniffed, dataBase64: dataBase64.replace(/\s/g, ''), bytes: bytes.length };
}

/**
 * 识别一张图片。
 *
 * @throws {VisionInputError} 入参不合法、或识别结果为空（由路由层转 400）
 * @throws {ModelError} 模型侧失败（超时 / 鉴权 / 配额等）——**原样抛出**，
 *   交给既有的 `mapModelError` 映射成正确状态码与 `retryable`，不在此处吞掉
 */
export async function recognizeImage(
  image: NormalizedImage,
  options: RecognizeOptions,
): Promise<VisionResult> {
  const log = options.logger ?? defaultLogger;
  const startedAt = Date.now();
  log.info('parse.vision.start', { mediaType: image.mediaType, bytes: image.bytes });

  const blocks: ModelInputBlock[] = [];
  const hint = options.hint?.trim();
  if (hint !== undefined && hint.length > 0) {
    blocks.push({ type: 'text', text: `学生的补充说明（仅供参考）：${hint}` });
  }
  blocks.push({ type: 'image', mediaType: image.mediaType, dataBase64: image.dataBase64 });

  // 模型调用：超时、重试、日志都由 withBudget 包装后的 caller 负责
  const raw = await options.caller(blocks, { system: VISION_SYSTEM_PROMPT, json: true });
  const ms = Date.now() - startedAt;

  // 学生自己写的字先落进正文（不丢），再拼识别结果 —— 见 RecognizeOptions.hint
  const prefix = hint !== undefined && hint.length > 0 ? `${hint}\n\n` : '';
  const interpreted = interpretModelOutput(raw, prefix);

  if (!interpreted.ok) {
    if (interpreted.reason === 'empty') {
      throw new VisionInputError(
        '这张图片没有识别出可用的文字内容，请换一张更清晰的图片或直接粘贴文字',
      );
    }
    // 降级而非报错：把原文当文本用，并如实标注"未按结构化格式返回"
    const text = interpreted.rawText;
    log.warn('parse.vision.degraded', {
      ms,
      reason: 'model-output-not-json',
      textLength: text.length,
    });
    return {
      text,
      lowConfidence: [
        {
          start: 0,
          end: Math.min(text.length, 120),
          reason: '模型未按结构化格式返回，已按纯文本采用；描述与公式信息本次缺失',
        },
      ],
    };
  }

  const { text, formulas, lowConfidence, imageDescription, imageStructure } = interpreted.value;
  log.info('parse.vision.ok', {
    ms,
    textLength: text.length,
    formulaCount: formulas.length,
    lowConfidenceCount: lowConfidence.length,
    hasStructure: imageStructure !== undefined,
  });

  return {
    text,
    lowConfidence,
    ...(imageDescription !== undefined ? { imageDescription } : {}),
    ...(imageStructure !== undefined ? { imageStructure } : {}),
    ...(formulas.length > 0 ? { formulas } : {}),
  };
}
