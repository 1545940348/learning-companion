/**
 * 语音输入按钮（A1 要求的三入口之一：文字 / 图片 / 语音）。
 *
 * ### 为什么做成自包含组件
 *
 * 面板只需要写一行 `<VoiceInputButton onTranscript={…} />`，不必知道
 * 识别怎么起停、超时怎么算、失败怎么分。这样：
 * - 语音的逻辑不落进任何面板函数（面板改动面最小，合并冲突风险最低）；
 * - 将来别的入口要复用，直接再放一个即可。
 *
 * ### ⚠️ 界面必须写明"识别在你的浏览器里完成"
 *
 * `D3`（2026-09-19 拍板）走的是浏览器内置识别，**服务端不做语音转写**。
 * 因此按钮下方常驻一句说明，避免被读成"服务端具备语音识别能力"
 * —— 这与 `/api/health` 里 `capabilities.audio.available = false` 是同一口径。
 *
 * ### 时间戳（说明书 §2.2「保留时间戳以便溯源」）
 *
 * 转写结果 `TranscriptSpan[]` 的 shape 为
 * `{ startMs: number; endMs: number; text: string }[]`（毫秒，相对本次开始说话的时刻）。
 * 组件把它们拼成"第几秒到第几秒"展示出来供学生对照；
 * **调用方只拿文本**（材料管道不需要时间轴）。
 * ⚠️ 这是**辨认出这句话的时刻**，不是学生开口的时刻 —— 文案里如实写明。
 *
 * ### 排版约定
 *
 * 外层 `span.voice-input` 在 `index.css` 里是 `display: contents`：
 * 按钮直接参与 `.actions` 的横向排列，而几条说明用 `flex-basis: 100%` 各占一行
 * （否则说明会与按钮挤在同一行里）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_VOICE_SECONDS, type TranscriptSpan } from '@lc/contracts';
import {
  detectVoiceSupport,
  type VoiceEnvironment,
  type VoiceOutcome,
} from '../shared/lib/voice-support';
import { startVoiceInput, type VoiceSession } from '../shared/lib/voice-input';

type Props = {
  /** 拿到转写文本。调用方决定是塞进输入框还是直接提交 */
  onTranscript: (text: string) => void;
  /** 有别的动作在跑时禁用（与面板其它按钮同一套门控） */
  disabled?: boolean;
  /**
   * **仅供测试注入**的运行环境（省略即取 `globalThis`）。
   *
   * 生产代码**不传** —— 传了就等于绕开对真实浏览器能力的探测。
   * 存在的理由：`verify-render` 跑在 node 里，那里根本没有 `SpeechRecognition`，
   * 若不能注入，"浏览器支持时界面长什么样"就完全测不到（只能测到不支持那一支）。
   */
  env?: VoiceEnvironment;
};

type Phase = 'idle' | 'listening' | 'settling';

/** 毫秒 → 保留一位小数的秒（0.4 秒 / 3.1 秒，便于学生对照） */
function toSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export function VoiceInputButton({ onTranscript, disabled = false, env }: Props) {
  /* 探测在渲染期完成：不支持时按钮直接禁用，不让学生点了才知道 */
  const support = useMemo(() => detectVoiceSupport(env), [env]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [interim, setInterim] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(MAX_VOICE_SECONDS);
  const [lastSpans, setLastSpans] = useState<TranscriptSpan[]>([]);

  const sessionRef = useRef<VoiceSession | null>(null);
  const deadlineRef = useRef(0);

  /* 倒计时只用于显示"还剩几秒"；真正的到点停止由 voice-input 的超时负责 */
  useEffect(() => {
    if (phase !== 'listening') return;
    const tick = () => {
      setRemaining(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [phase]);

  /* 组件被卸载（例如"开始新学习"重挂面板）时放弃在飞的识别，不留麦克风在后台 */
  useEffect(
    () => () => {
      sessionRef.current?.abort();
    },
    [],
  );

  /** 收尾归口：**永不抛异常**（`result` 保证 resolve），失败一律降级成一句人话 */
  function handleOutcome(outcome: VoiceOutcome): void {
    sessionRef.current = null;
    setPhase('idle');
    setInterim('');

    if (outcome.ok) {
      onTranscript(outcome.text);
      setLastSpans(outcome.spans);
      setProblem(null);
      return;
    }

    // 学生自己取消的：不报错、不显示失败（与请求取消同一口径）
    if (outcome.code === 'aborted') return;

    // 中断但**已经说出来的部分**：内容照常使用，同时如实说明为什么停了
    if (outcome.text.length > 0) {
      onTranscript(outcome.text);
      setLastSpans(outcome.spans);
      setProblem(outcome.problem);
      return;
    }

    setProblem(outcome.problem);
  }

  function handleStart(): void {
    setProblem(null);
    setInterim('');
    setLastSpans([]);

    // 注入的 env 要一路传到会话里：只影响探测、不影响起停，会让测试与真实行为不一致
    const session = startVoiceInput({
      onInterim: setInterim,
      ...(env !== undefined ? { env } : {}),
    });
    sessionRef.current = session;
    deadlineRef.current = Date.now() + MAX_VOICE_SECONDS * 1000;
    setRemaining(MAX_VOICE_SECONDS);
    setPhase('listening');
    void session.result.then(handleOutcome);
  }

  function handleStop(): void {
    const session = sessionRef.current;
    if (session === null) return;
    setPhase('settling');
    // 按停后由收尾窗口等引擎补吐最后一句，结果仍走 handleOutcome
    session.stop();
  }

  const unsupported = !support.supported;

  return (
    <span className="voice-input">
      {phase === 'idle' ? (
        <button
          className="btn btn-ghost"
          onClick={handleStart}
          disabled={disabled || unsupported}
          title={unsupported ? support.problem : '用麦克风说话，在浏览器里转成文字后填入输入框'}
        >
          语音输入
        </button>
      ) : (
        <button
          className="btn btn-ghost"
          onClick={handleStop}
          disabled={phase === 'settling'}
          title="停止并保留已经说出的内容"
        >
          {phase === 'listening' ? `停止（还可说 ${remaining} 秒）` : '正在收尾…'}
        </button>
      )}

      {/* 不支持时也要让"为什么不能用"看得见，而不是给一个灰按钮了事 */}
      {unsupported && (
        <span className="hint-inline voice-input-note">{support.problem}</span>
      )}

      {/* 识别发生的位置常驻说明（D3 口径：不得声称是服务端识别） */}
      {!unsupported && phase === 'idle' && (
        <span className="hint-inline voice-input-note">
          识别在你的浏览器里完成（需要联网）；转成文字后按普通文字提交，服务端不做语音转写。
        </span>
      )}

      {phase === 'listening' && (
        <span className="hint-inline voice-input-note">
          {interim.trim().length > 0 ? `正在听：${interim}` : '正在听…请对着麦克风说。'}
        </span>
      )}

      {lastSpans.length > 0 && (
        <span className="hint-inline voice-input-note">
          上一段语音的转写记录（
          {lastSpans
            .map((span) => `${toSeconds(span.startMs)}–${toSeconds(span.endMs)} 秒`)
            .join(' / ')}
          ）—— 这是辨认出这句话的时刻，不是学生开口的时刻。
        </span>
      )}

      {problem !== null && <span className="hint-inline voice-input-note">{problem}</span>}
    </span>
  );
}
