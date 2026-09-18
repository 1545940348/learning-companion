/**
 * 答疑与来源（A4）
 *
 * 说明书 §2.5 的三条界面要求：
 * - 三种模式并存，**默认先给提示**，完整解答由学生主动选择；
 * - 回答默认是「简洁正文 + 引用角标」，点角标才展开「依据详情」；
 * - 「依据详情」含来源类别、引用片段、所用规则与**验证状态**。
 */

import { useState } from 'react';
import type { AnswerBlock, TutorMode } from '@lc/contracts';
import type { TutorTurn, WorkbenchActions, WorkbenchState } from '../hooks/useWorkbench';
import { SCOPE_LABELS, SOURCE_LABELS, TUTOR_MODE_LABELS, VERIFICATION_LABELS, verificationClass } from '../lib/labels';

type Props = { wb: WorkbenchState & WorkbenchActions; mock: boolean };

const MODES: TutorMode[] = ['hint', 'explain', 'full'];

export function TutorPanel({ wb, mock }: Props) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<TutorMode>('hint');
  const busy = wb.isBusy('tutor');
  const zeroMaterial = wb.materials.length === 0;

  async function handleAsk() {
    const ok = await wb.ask(question, mode);
    if (ok) setQuestion('');
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>答疑</h2>
        <span className="meta">
          {zeroMaterial ? '轻路径 · 未基于你的材料' : `材料路径 · 版本 v${wb.materialVersion}`}
        </span>
      </header>

      {zeroMaterial && (
        <p className="hint">
          可以不上传材料直接问。此时回答会标注「未基于你的材料」；上传讲义后可以按你老师的定义方式再讲一遍。
        </p>
      )}

      <textarea
        className="input"
        rows={4}
        value={question}
        placeholder="例如：为什么 f'(x) > 0 就能说明函数递增？"
        onChange={(event) => setQuestion(event.target.value)}
      />

      <div className="actions">
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
        <button className="btn" onClick={handleAsk} disabled={busy || question.trim().length === 0}>
          {busy ? '正在解答…' : '提问'}
        </button>
      </div>

      {wb.history.length === 0 ? (
        <p className="hint">还没有问答记录。默认先给提示，不会一上来就抛完整解答。</p>
      ) : (
        <div className="turns">
          {[...wb.history].reverse().map((turn) => (
            <Turn key={turn.id} turn={turn} mock={mock} />
          ))}
        </div>
      )}
    </section>
  );
}

function Turn({ turn, mock }: { turn: TutorTurn; mock: boolean }) {
  const [detail, setDetail] = useState<number | null>(null);

  return (
    <div className="turn">
      <div className="turn-q">
        <span className="turn-mode">{TUTOR_MODE_LABELS[turn.mode]}</span>
        {turn.question}
        {turn.stale && <span className="tag tag-pending">依据已更新</span>}
      </div>

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
