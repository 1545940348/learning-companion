/**
 * 主栏对话流（L 档改造，2026-09-23）
 *
 * 它是原 `TutorPanel` 的演化：**同样的数据、同样的真实性标注**，但按"agent 平台"的
 * 交互排布 —— 消息正序（新的在下）、输入区固定在底部、滚动区独立。
 *
 * ### 与旧版的**不变量**（这些是断言与验收判据，不许顺手改掉）
 *
 * - 回答块的**四类来源标注**：`SOURCE_LABELS` 角标、验证状态、`AI 补充：非上传讲义内容` 横幅；
 * - **`mock 演示数据`** 标记（仅 mock 通道出现，真实通道一个字都不出现）；
 * - **`基于你的材料` / `未基于你的材料`**；
 * - **`I14` 的丢弃事实**：`本次回答不完整` + `另有 N 段内容没有展示` + 具体原因；
 * - **`下一步：`** 引导与 **`依据已更新`**（`stale`）标记；
 * - 引用角标的展开/收起（`cite-badge` / `cite-active` / `citation-detail`）。
 *
 * ### 有意**删掉**的
 *
 * 原先两条"解释性小字"（"可以不上传材料直接问…"、"还没有问答记录。默认先给提示…"）
 * —— 按 UI 要求"避免不必要的说明性小字"移除；空态改成**图标 + 可点的示例问题**，
 * 信息量不减、噪音更少。
 */

import { useEffect, useRef, useState } from 'react';
import type { AnswerBlock, TutorMode } from '@lc/contracts';
import type { TutorTurn, Workbench } from '../app/model/workbench-types';
import { describePending, formatClock, toChatMessages, type ChatMessage } from '../app/model/conversation';
import {
  SCOPE_LABELS,
  SOURCE_LABELS,
  TUTOR_MODE_LABELS,
  VERIFICATION_LABELS,
  verificationClass,
} from '../shared/lib/labels';
import { Icon } from './Icon';

type Props = { wb: Workbench; mock: boolean };

const MODES: TutorMode[] = ['hint', 'explain', 'full'];

/** 空态里给的示例问题：**必须是真的能问的问题**，不写装饰性文案 */
const SAMPLES = ['为什么 f′(x) > 0 就能说明函数递增？', '切线方程是怎么求出来的？'];

export function ConversationView({ wb, mock }: Props) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<TutorMode>('hint');
  const busy = wb.isBusy('tutor');
  const zeroMaterial = wb.materials.length === 0;
  const messages = toChatMessages(wb.history);
  const pending = describePending(wb.busy);
  const scroller = useRef<HTMLDivElement | null>(null);

  /* 新消息到达时贴底（`renderToStaticMarkup` 下不执行，故不影响渲染断言） */
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, wb.anyBusy]);

  async function handleAsk() {
    const ok = await wb.ask(question, mode);
    if (ok) setQuestion('');
  }

  return (
    <section className="panel conversation">
      <header className="panel-head">
        <h2>答疑</h2>
        <span className="meta">
          {zeroMaterial ? '轻路径 · 未基于你的材料' : `材料路径 · 版本 v${wb.materialVersion}`}
        </span>
      </header>

      <div className="conv-scroll" ref={scroller}>
        {messages.length === 0 ? (
          <div className="conv-empty">
            <Icon name="sparkle" size={26} />
            <p className="conv-empty-title">问一个微积分问题</p>
            <div className="conv-samples">
              {SAMPLES.map((sample) => (
                <button key={sample} className="sample" onClick={() => setQuestion(sample)}>
                  {sample}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => <MessageRow key={message.id} message={message} mock={mock} />)
        )}
      </div>

      <div className="composer">
        {pending && (
          <div className="composer-status">
            <Icon name="refresh" className="spin" size={15} />
            <span>{pending}</span>
            <span className="composer-status-spacer" />
            <button className="link" onClick={wb.cancelPending}>
              取消
            </button>
          </div>
        )}

        <textarea
          className="input composer-input"
          rows={2}
          value={question}
          placeholder="例如：为什么 f'(x) > 0 就能说明函数递增？"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            /* Ctrl/Cmd + Enter 发送：经典桌面习惯，不打断换行 */
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy) {
              void handleAsk();
            }
          }}
        />

        <div className="composer-bar">
          <div className="mode-group" role="group" aria-label="回答模式">
            {MODES.map((item) => (
              <button
                key={item}
                className={item === mode ? 'mode mode-active' : 'mode'}
                onClick={() => setMode(item)}
              >
                {TUTOR_MODE_LABELS[item]}
              </button>
            ))}
          </div>
          <button
            className="btn composer-send"
            onClick={handleAsk}
            disabled={busy || question.trim().length === 0}
          >
            <Icon name={busy ? 'refresh' : 'send'} size={16} className={busy ? 'spin' : undefined} />
            {busy ? '正在解答…' : '提问'}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ==================== 单条消息 ==================== */

function MessageRow({ message, mock }: { message: ChatMessage; mock: boolean }) {
  if (message.kind === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-body">
          <span className="msg-mode">{TUTOR_MODE_LABELS[message.mode]}</span>
          {message.text}
        </div>
        <time className="msg-time">{formatClock(message.at)}</time>
      </div>
    );
  }

  return <AnswerRow turn={message.turn} mock={mock} />;
}

function AnswerRow({ turn, mock }: { turn: TutorTurn; mock: boolean }) {
  const [detail, setDetail] = useState<number | null>(null);

  return (
    <div className="msg msg-answer">
      <div className="msg-avatar">
        <Icon name="sparkle" size={16} />
      </div>
      <div className="msg-body">
        <div className="turn-meta">
          <span className="tag tag-muted">{SCOPE_LABELS[turn.answer.scope]}</span>
          <span className={turn.answer.basedOnMaterial ? 'tag tag-local' : 'tag tag-pending'}>
            {turn.answer.basedOnMaterial ? '基于你的材料' : '未基于你的材料'}
          </span>
          {mock && (
            <span className="tag tag-failed" title="当前是演示通道，回答由固定演示数据生成">
              mock 演示数据
            </span>
          )}
          {turn.stale && <span className="tag tag-pending">依据已更新</span>}
        </div>

        {turn.answer.blocks.map((block, index) => (
          <Block key={index} block={block} openIndex={detail} onToggle={setDetail} />
        ))}

        {/*
          `I14`：被来源校验拦下的块**不得无声消失**。
          原先只要还有块通过，被拒的块就从响应里没了 —— 学生看到的是残缺答案，
          且无从知道少了一段。服务端把丢弃事实放进 `droppedBlocks`，这里必须显示出来。
        */}
        {turn.answer.droppedBlocks && (
          <p className="warn-inline">
            本次回答不完整：另有 {turn.answer.droppedBlocks.count} 段内容没有展示 ——
            未通过来源校验（{turn.answer.droppedBlocks.reasons.join('；')}）。
            这通常意味着那段内容既无法定位到你的材料、又不属于你已授权补充的段落；
            系统按规则把它拦下了，而不是当作正常答案交给你。
          </p>
        )}

        {turn.answer.nextStep && (
          <p className="hint-inline">下一步：{turn.answer.nextStep.message}</p>
        )}

        {turn.stale && (
          <p className="hint-inline">
            这条回答是在材料更新之前给出的。图谱已按新内容重建，请以最新的知识点卡片为准。
          </p>
        )}
      </div>
    </div>
  );
}

function Block({
  block,
  openIndex,
  onToggle,
}: {
  block: AnswerBlock;
  openIndex: number | null;
  onToggle: (index: number | null) => void;
}) {
  const isAiSupplement = block.sourceType === 'ai-supplement';
  const activeCitation = openIndex === null ? null : block.citations[openIndex];

  return (
    <div className={isAiSupplement ? 'block block-ai' : 'block'}>
      {isAiSupplement && <div className="supplement-banner">AI 补充：非上传讲义内容</div>}

      <p className="block-text">{block.content}</p>

      <div className="block-foot">
        <span className="source-tag">{SOURCE_LABELS[block.sourceType]}</span>
        <span className={verificationClass(block.verification)}>
          {VERIFICATION_LABELS[block.verification]}
        </span>

        {block.citations.length > 0 &&
          block.citations.map((citation, index) => (
            <button
              key={`${citation.refId}-${index}`}
              className={index === openIndex ? 'cite-badge cite-active' : 'cite-badge'}
              onClick={() => onToggle(openIndex === index ? null : index)}
            >
              {index + 1}
            </button>
          ))}
      </div>

      {activeCitation && (
        <div className="citation-detail">
          <div>
            <span className="kp-label">来源类别</span>
            {SOURCE_LABELS[activeCitation.sourceType]}
          </div>
          <div>
            <span className="kp-label">来源编号</span>
            <code>{activeCitation.refId}</code>
          </div>
          <div>
            <span className="kp-label">引用片段</span>
            {activeCitation.excerpt.length > 0 ? activeCitation.excerpt : '（未附摘录）'}
          </div>
          <div>
            <span className="kp-label">验证状态</span>
            <span className={verificationClass(block.verification)}>
              {VERIFICATION_LABELS[block.verification]}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
