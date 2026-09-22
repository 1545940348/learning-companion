/**
 * 语音输入的**会话逻辑**：把学生说的话在浏览器里转成文字，交给调用方当普通文本用。
 *
 * ### 分工（与 `voice-support.ts` 的边界）
 *
 * 本文件管「**怎么跑起来**」：状态机、定时器、事件接线、幂等收尾。
 * `voice-support.ts` 管「**它是什么、怎么说**」：能力探测、失败码、面向学生的一句话。
 *
 * ### 边界防御（三处外部 I/O：麦克风硬件 / 识别引擎 / 网络）
 *
 * - **先探测再动手**：不支持的浏览器不该等到点了才报错；
 * - **超时**：`MAX_VOICE_SECONDS`（60 s，来自契约）是硬上限。引擎挂住不返回时强制收尾，
 *   且**已说出的部分照样保留** —— 不让学生白说一遍；
 * - **收尾窗口**：按停后引擎还会补吐最后一条结果，直接切断会吞掉最后一句话，
 *   故给一个短窗口（默认 800 ms），窗口到点或 `onend` 到达即收尾，先到者为准；
 * - **异常**：构造与 `start()` 都可能同步抛（`InvalidStateError`），全部就地捕获。
 *   **本模块在任何情况下都不向上抛异常**，一律降级为 `VoiceFailure`；
 * - **日志**：`voice.start / voice.result / voice.error / voice.timeout`，可注入（测试用静音版）。
 *
 * ### 时间戳（说明书 §2.2「保留时间戳以便溯源」）
 *
 * `TranscriptSpan` 的 `startMs/endMs` 是**本机测量**的"这一句在第几秒被识别到"，
 * 由 `Date.now()` 在 `result` 事件到达时取得。
 * ⚠️ **它不是引擎提供的语音时间轴** —— Web Speech API 不提供该信息。
 * 界面上也如实写明，不把"到达时刻"包装成"发音时刻"。
 */

import { MAX_VOICE_SECONDS, type TranscriptSpan } from '@lc/contracts';
import {
  defaultVoiceLogger,
  describeVoiceFailure,
  detectVoiceSupport,
  mapSpeechErrorCode,
  resolveRecognitionCtor,
  type SpeechRecognitionLike,
  type VoiceEnvironment,
  type VoiceFailureCode,
  type VoiceLogger,
  type VoiceOutcome,
} from './voice-support.js';

export interface VoiceInputOptions {
  /** 中间结果（还没定稿的那半句），用于"正在听：…"的实时显示 */
  onInterim?: (text: string) => void;
  /** 识别语言，默认 `zh-CN`（本项目是中文数学讲义场景） */
  lang?: string;
  /** 时长上限，默认 `MAX_VOICE_SECONDS × 1000` */
  timeoutMs?: number;
  /** 按停后的收尾窗口，默认 800 ms */
  settleMs?: number;
  logger?: VoiceLogger;
  env?: VoiceEnvironment;
}

export interface VoiceSession {
  /** 一定 resolve，**不会 reject** */
  result: Promise<VoiceOutcome>;
  /** 学生按停：保留已识别内容并收尾 */
  stop: () => void;
  /** 放弃：丢弃内容，不当作失败告警 */
  abort: () => void;
}

/** 已经定稿、不再变化的一次会话（`stop` / `abort` 此时都是空操作） */
const IDLE_SESSION = (result: Promise<VoiceOutcome>): VoiceSession => ({
  result,
  stop: () => {},
  abort: () => {},
});

/** 把已定稿的片段拼成文本，多句换行分隔（保持"一句一行"的可读性） */
function joinSpans(spans: readonly TranscriptSpan[]): string {
  return spans
    .map((span) => span.text.trim())
    .filter((item) => item.length > 0)
    .join('\n');
}

/**
 * 开始一次语音识别。**不抛异常** —— 不支持、被拒、超时、引擎崩，全都变成
 * `VoiceFailure`。调用方拿到的永远是"一个结果"，不需要 try/catch。
 */
export function startVoiceInput(options: VoiceInputOptions = {}): VoiceSession {
  const log = options.logger ?? defaultVoiceLogger;
  const env = options.env ?? (globalThis as VoiceEnvironment);
  const timeoutMs = options.timeoutMs ?? MAX_VOICE_SECONDS * 1000;
  const settleMs = options.settleMs ?? 800;
  const lang = options.lang ?? 'zh-CN';

  const spans: TranscriptSpan[] = [];
  const startedAt = Date.now();
  let lastEndMs = 0;
  let settled = false;
  let timedOut = false;
  let recognition: SpeechRecognitionLike | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveResult!: (outcome: VoiceOutcome) => void;

  const result = new Promise<VoiceOutcome>((resolve) => {
    resolveResult = resolve;
  });

  const elapsed = (): number => Date.now() - startedAt;

  /** 幂等收尾：清定时器、解绑回调、resolve 恰好一次 */
  function settle(outcome: VoiceOutcome): void {
    if (settled) return;
    settled = true;
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    if (settleTimer !== null) clearTimeout(settleTimer);
    timeoutTimer = null;
    settleTimer = null;
    if (recognition !== null) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
    }
    resolveResult(outcome);
  }

  function finalizeFailure(code: VoiceFailureCode): void {
    const info = describeVoiceFailure(code);
    // 已说出来的部分照样交回去 —— 超时/断网不该让学生白说一遍
    const text = joinSpans(spans);
    settle({
      ok: false,
      code,
      problem: info.problem,
      retryable: info.retryable,
      text,
      spans: [...spans],
      durationMs: elapsed(),
    });
    log.warn('voice.error', {
      code,
      ms: elapsed(),
      segments: spans.length,
      chars: text.length,
      partial: text.length > 0,
    });
  }

  /** 结束时的归口：有内容算成功；没内容不放行空文本，按 `empty` 处理 */
  function finalizeEnd(): void {
    const text = joinSpans(spans);
    if (text.length === 0) {
      finalizeFailure('empty');
      return;
    }
    settle({ ok: true, text, spans: [...spans], durationMs: elapsed() });
    log.info('voice.result', { ms: elapsed(), segments: spans.length, chars: text.length });
  }

  /** 收尾窗口：等引擎补吐最后一条，或到点就走（先到者为准） */
  function beginSettleWindow(onDeadline: () => void): void {
    if (settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      onDeadline();
    }, settleMs);
  }

  function stopInternal(): void {
    if (settled) return;
    try {
      recognition?.stop();
    } catch {
      // 引擎已在结束过程中时 stop() 会抛，忽略即可 —— 收尾窗口会兜住
    }
  }

  /* ---------- 起手：先探测，再动手 ---------- */

  const support = detectVoiceSupport(env);
  if (!support.supported) {
    log.warn('voice.unsupported', { code: support.code });
    settle({
      ok: false,
      code: support.code,
      problem: support.problem,
      retryable: false,
      text: '',
      spans: [],
      durationMs: 0,
    });
    return IDLE_SESSION(result);
  }

  const Ctor = resolveRecognitionCtor(env);

  /* ---------- 装配实例（构造与启动都可能抛，一并兜住） ---------- */

  try {
    if (Ctor === null) throw new Error('no SpeechRecognition constructor');
    recognition = new Ctor();
    recognition.lang = lang;
    // 连续识别：学生可以连着说几句，不必每句都重新按一次
    recognition.continuous = true;
    // 中间结果：让界面能边听边显示，学生知道系统在动
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      log.info('voice.start', { lang, timeoutMs });
    };

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const item = event.results[i];
        if (!item) continue;
        const raw = item[0]?.transcript ?? '';
        if (item.isFinal) {
          const at = elapsed();
          const text = raw.trim();
          if (text.length > 0) {
            // startMs 取上一条的结束点：句与句首尾相接，不重叠也不留空隙
            spans.push({ startMs: lastEndMs, endMs: at, text });
            lastEndMs = at;
          }
          options.onInterim?.('');
        } else {
          options.onInterim?.(raw);
        }
      }
    };

    recognition.onerror = (event) => {
      const code = mapSpeechErrorCode(event.error);
      log.warn('voice.upstream-error', { raw: event.error, code });
      finalizeFailure(code);
    };

    recognition.onend = () => {
      if (settled) return;
      log.info('voice.stop', { ms: elapsed(), segments: spans.length });
      // 到过上限的，如实按"超时"收尾 —— 否则学生会以为是自己说完了
      if (timedOut) {
        finalizeFailure('timeout');
        return;
      }
      finalizeEnd();
    };

    recognition.start();
  } catch (error) {
    // `start()` 同步抛（如 InvalidStateError：上一次还没结束）→ 不让它冒到界面上
    log.error('voice.start-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    finalizeFailure('unknown');
    return IDLE_SESSION(result);
  }

  /* ---------- 硬上限：到点强制收尾，已说出的部分保留 ---------- */

  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    timedOut = true;
    log.warn('voice.timeout', { timeoutMs, segments: spans.length });
    stopInternal();
    beginSettleWindow(() => finalizeFailure('timeout'));
  }, timeoutMs);

  return {
    result,
    stop: () => {
      if (settled) return;
      log.info('voice.stop-requested', { ms: elapsed(), segments: spans.length });
      stopInternal();
      beginSettleWindow(() => finalizeEnd());
    },
    abort: () => {
      if (settled) return;
      try {
        recognition?.abort();
      } catch {
        // 同上：引擎可能在结束中，忽略
      }
      log.info('voice.aborted', { ms: elapsed(), segments: spans.length });
      settle({
        ok: false,
        code: 'aborted',
        problem: describeVoiceFailure('aborted').problem,
        retryable: false,
        // 学生自己取消的，既不报失败，也不把半截内容硬塞回输入框
        text: '',
        spans: [],
        durationMs: elapsed(),
      });
    },
  };
}
