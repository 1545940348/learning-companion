/**
 * 语音输入的**能力探测、结果形状与对外说法**。
 *
 * ### 为什么和 `voice-input.ts` 分开
 *
 * 与 `apps/server/src/parse/vision.ts` / `vision-output.ts` 同一分工：
 * - 本文件管「**它是什么、怎么说**」：能力探测、失败码、面向学生的一句话；
 * - `voice-input.ts` 管「**怎么跑起来**」：会话状态机、定时器、事件接线。
 *
 * 换浏览器、换识别引擎时动 `voice-input.ts`；**调文案只动本文件**
 * （文案是"如实说明"的一部分，集中一处才好核对口径）。
 *
 * ### ⚠️ 识别发生在浏览器，不在服务端（事实陈述，不是实现细节）
 *
 * `D3`（2026-09-19 负责人拍板）定的是「语音优先浏览器内置识别」，服务端**不做** ASR。
 * 因此两件事必须分开说：`/api/parse` 的语音路径**依然"未接入"**
 * （见 `apps/server/src/parse/capabilities.ts`），本模块也**不发任何请求**。
 *
 * ### 为什么自己定义接口而不依赖 lib.dom
 *
 * `SpeechRecognition` 与 `webkitSpeechRecognition` 在各版 TypeScript 的 DOM 类型里
 * 有无不一（后者基本没有），直接引用会让本模块随 TS 版本编译失败。
 * 这里只声明**真正用到的字段**（最小接口），顺带起"形状标注"的作用。
 */

import { MAX_VOICE_SECONDS, type TranscriptSpan } from '@lc/contracts';

/* ==================== 日志 ==================== */

/** 与服务端 `apps/server/src/logger.ts` 同形，便于注入与静音 */
export interface VoiceLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export const defaultVoiceLogger: VoiceLogger = {
  info: (message, fields) => console.info(`[voice] ${message}`, fields ?? {}),
  warn: (message, fields) => console.warn(`[voice] ${message}`, fields ?? {}),
  error: (message, fields) => console.error(`[voice] ${message}`, fields ?? {}),
};

/** 测试用：丢弃全部日志（否则业务日志会和断言输出混在一起，看不出哪条失败） */
export const silentVoiceLogger: VoiceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/* ==================== Web Speech API 的最小接口 ==================== */

interface SpeechAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

/** 一条识别结果：`isFinal` 为真表示这句已定稿（不会再改） */
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike | undefined;
}

interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike | undefined;
}

export interface SpeechResultEventLike {
  /** 本次从第几条开始更新（连续识别下 `results` 会累积，必须从这里起读） */
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}

export interface SpeechErrorEventLike {
  /** 上游错误码，如 `not-allowed` / `no-speech` / `network` */
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: ((event: unknown) => void) | null;
  onstart: ((event: unknown) => void) | null;
}

export type SpeechRecognitionCtorLike = new () => SpeechRecognitionLike;

/**
 * 可注入的运行环境（默认 `globalThis`）。
 *
 * 测试里传一个假对象，即可在不装浏览器、不用真麦克风的前提下覆盖全部分支。
 */
export interface VoiceEnvironment {
  speechRecognition?: SpeechRecognitionCtorLike | undefined;
  webkitSpeechRecognition?: SpeechRecognitionCtorLike | undefined;
  isSecureContext?: boolean | undefined;
}

/* ==================== 结果与失败 ==================== */

/** 失败码逐条对应一种真实成因，不用一个 `unknown` 糊住所有情况 */
export type VoiceFailureCode =
  | 'unsupported' // 浏览器没有这个能力
  | 'insecure-context' // 非 https，浏览器禁止用麦克风
  | 'not-allowed' // 权限被拒
  | 'audio-capture' // 找不到麦克风
  | 'network' // 识别服务连不上
  | 'no-speech' // 没听到声音
  | 'aborted' // 学生主动取消
  | 'timeout' // 到达时长上限
  | 'empty' // 没识别出文字
  | 'unknown'; // 其他未预期原因

export interface VoiceSuccess {
  ok: true;
  /** 完整转写文本（已 trim；多句之间换行连接） */
  text: string;
  /** 逐句到达时间窗：`{ startMs: number; endMs: number; text: string }[]`，用于溯源展示 */
  spans: TranscriptSpan[];
  durationMs: number;
}

export interface VoiceFailure {
  ok: false;
  code: VoiceFailureCode;
  /** 面向学生的一句话，可直接展示，调用方不需再加工 */
  problem: string;
  /** 是否值得再试（"取消"与"浏览器不支持"都不值得） */
  retryable: boolean;
  /** **中断前已经说出来的部分**（可能为空串）。超时时尤其要保留，不整段丢弃 */
  text: string;
  spans: TranscriptSpan[];
  durationMs: number;
}

export type VoiceOutcome = VoiceSuccess | VoiceFailure;

/** 每个失败码的对外说法与可重试性，集中一处（文案打磨只改这里） */
const FAILURE_INFO: Record<VoiceFailureCode, { problem: string; retryable: boolean }> = {
  unsupported: {
    problem: '这个浏览器不支持语音输入。请换用 Chrome 或 Edge，或者直接把问题打字输入。',
    retryable: false,
  },
  'insecure-context': {
    problem: '当前不是安全连接（https），浏览器不允许使用麦克风。请直接把问题打字输入。',
    retryable: false,
  },
  'not-allowed': {
    problem: '麦克风权限被拒绝了。请在地址栏的权限提示里允许使用麦克风，然后再点一次。',
    retryable: true,
  },
  'audio-capture': {
    problem: '没有找到可用的麦克风。请检查设备是否接好，或者直接把问题打字输入。',
    retryable: true,
  },
  network: {
    problem:
      '语音识别服务连不上（浏览器需要联网才能识别）。这在一部分网络环境下会发生，请直接把问题打字输入。',
    retryable: true,
  },
  'no-speech': {
    problem: '没有听到声音。请靠近麦克风再说一次，或者直接把问题打字输入。',
    retryable: true,
  },
  aborted: { problem: '已取消语音输入。', retryable: false },
  timeout: {
    problem: `说到 ${MAX_VOICE_SECONDS} 秒上限，已自动停止。已经识别到的内容保留下来了。`,
    retryable: true,
  },
  empty: {
    problem: '没有识别出文字。请再说一次、说得清楚些，或者直接把问题打字输入。',
    retryable: true,
  },
  unknown: {
    problem: '语音输入没能完成。请重试，或者直接把问题打字输入。',
    retryable: true,
  },
};

/** 取某个失败码的对外说法（供 `voice-input.ts` 与界面复用） */
export function describeVoiceFailure(code: VoiceFailureCode): { problem: string; retryable: boolean } {
  return FAILURE_INFO[code];
}

/** 上游错误码 → 本模块失败码（`service-not-allowed` 与 `not-allowed` 同因不同名） */
export function mapSpeechErrorCode(raw: string): VoiceFailureCode {
  switch (raw) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'audio-capture':
      return 'audio-capture';
    case 'network':
      return 'network';
    case 'no-speech':
      return 'no-speech';
    case 'aborted':
      return 'aborted';
    case 'language-not-supported':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

/* ==================== 能力探测 ==================== */

export type VoiceSupport =
  | { supported: true }
  | {
      supported: false;
      code: Extract<VoiceFailureCode, 'unsupported' | 'insecure-context'>;
      problem: string;
    };

/** 取浏览器实际暴露的构造器（标准名优先，其次 `webkit` 前缀） */
export function resolveRecognitionCtor(
  env: VoiceEnvironment = globalThis as VoiceEnvironment,
): SpeechRecognitionCtorLike | null {
  return env.speechRecognition ?? env.webkitSpeechRecognition ?? null;
}

/**
 * 探测能否使用语音输入 —— **先探测再动手**。
 *
 * 不支持的浏览器上让按钮直接禁用并说明原因，比"点了才报错"体面得多，
 * 也让"这台机器行不行"在界面上是可见的。
 */
export function detectVoiceSupport(
  env: VoiceEnvironment = globalThis as VoiceEnvironment,
): VoiceSupport {
  if (resolveRecognitionCtor(env) === null) {
    return { supported: false, code: 'unsupported', ...FAILURE_INFO.unsupported };
  }
  // 只在**明确**判定为非安全上下文时才拦：`undefined`（旧浏览器 / 测试环境）
  // 不等于"不安全"，那种情况交给上游错误事件回答，不在这里替它下结论。
  if (env.isSecureContext === false) {
    return { supported: false, code: 'insecure-context', ...FAILURE_INFO['insecure-context'] };
  }
  return { supported: true };
}
