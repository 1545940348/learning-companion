/**
 * 材料输入与材料列表（A1、A2）
 *
 * 设计取向（说明书 §2.2、§2.4）：
 * - 识别文本**默认可直接使用**，不设"请确认识别结果"的阻断步骤；
 * - 识别不准的地方标「识别可能不准」，学生可就地修改；
 * - 两种上传动作分开：「补充当前材料」保留旧材料与图谱，「开始新学习」另起会话；
 * - 图文语音三个入口都**如实提示未接入**，不假装已识别（§9）。
 */

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MATERIAL_LIMITS } from '@lc/contracts';
import type { UiMaterial, WorkbenchActions, WorkbenchState } from '../hooks/useWorkbench';
import { totalTextLength } from '../hooks/useWorkbench';

type Props = { wb: WorkbenchState & WorkbenchActions; mock: boolean };

const PLACEHOLDER = `把讲义、题目或任何看不懂的段落粘贴到这里。

例如：
判断 f(x) 的单调性时，只需看 f'(x) 的符号：
f'(x) > 0 时函数递增，f'(x) < 0 时函数递减。`;

/** 尚未接入的识别通道 → 面向学生的说明（**不假装已解析**） */
const UNAVAILABLE_TEXT: Record<string, string> = {
  image: '图片识别',
  audio: '语音转写',
  formula: '公式识别（LaTeX）',
};

export function MaterialPanel({ wb, mock }: Props) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);

  const used = totalTextLength(wb.materials);
  const parsing = wb.isBusy('knowledge');
  const hasMaterials = wb.materials.length > 0;

  async function handleSubmit() {
    // 只有成功才清空输入框 —— §5.4 要求失败时保留学生的输入
    const ok = await wb.submitMaterials([draft]);
    if (ok) setDraft('');
  }

  /** 图片入口：服务端尚未接入视觉识别时如实告知，不静默丢弃（§9） */
  function handleImagePicked() {
    if (fileRef.current) fileRef.current.value = '';
    wb.notify(
      '视觉识别尚未接入：目前上传图片无法识别内容。请把讲义或题目的文字粘贴到输入框里 —— ' +
        '文字路径是完整可用的。',
      'warn',
    );
  }

  /** 语音入口：与图片同理，入口存在但如实说明未接入（A1 要求三个入口齐全） */
  function handleAudioPicked() {
    if (audioRef.current) audioRef.current.value = '';
    wb.notify(
      '语音转写尚未接入：目前不能从音频识别内容。请把要问的内容打成文字 —— ' +
        `文字路径是完整可用的（单段语音接入后上限 ${60} 秒）。`,
      'warn',
    );
  }

  const unavailable = wb.parseUnavailable.filter((item) => UNAVAILABLE_TEXT[item]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>材料</h2>
        <span className="meta">
          {wb.materials.length} / {MATERIAL_LIMITS.maxMaterialsPerSession} 份 · {used} /{' '}
          {MATERIAL_LIMITS.maxTextLength} 字
        </span>
      </header>

      <p className="hint">
        上传讲义后，系统会抽出知识点、判断哪些前置知识你的材料没讲，缺的那块可以直接补上。
      </p>

      <textarea
        className="input"
        rows={7}
        value={draft}
        placeholder={PLACEHOLDER}
        onChange={(event) => setDraft(event.target.value)}
        disabled={parsing}
      />

      <div className="actions">
        <button
          className="btn"
          onClick={handleSubmit}
          disabled={wb.anyBusy || draft.trim().length === 0}
        >
          {parsing ? '正在解析…' : hasMaterials ? '补充当前材料' : '解析这份材料'}
        </button>
        <button className="btn btn-ghost" onClick={handleImagePicked} disabled={wb.anyBusy}>
          上传图片
        </button>
        <button className="btn btn-ghost" onClick={handleAudioPicked} disabled={wb.anyBusy}>
          上传语音
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={handleImagePicked}
        />
        <input ref={audioRef} type="file" accept="audio/*" hidden onChange={handleAudioPicked} />
        <span className="count">
          单次 {draft.length} / {MATERIAL_LIMITS.maxSingleInputLength} 字
        </span>
      </div>

      {unavailable.length > 0 && (
        <p className="hint-inline">
          当前未接入的识别环节：
          {unavailable.map((item) => UNAVAILABLE_TEXT[item]).join('、')}
          。材料按纯文本参与解析 —— 这不是错误，是如实说明；接入后此提示会自动消失。
        </p>
      )}

      {mock && (
        <p className="hint-inline">
          演示通道提示：当前解析结果由固定的演示数据生成，不代表真实模型的抽取能力。
        </p>
      )}

      {hasMaterials && (
        <>
          <ul className="material-list">
            {wb.materials.map((item, index) => (
              <li key={item.id} className="material-item">
                <div className="material-head">
                  <span className="material-index">材料 {index + 1}</span>
                  {item.corrected && <span className="tag tag-pending">已修正</span>}
                  {item.lowConfidence && item.lowConfidence.length > 0 && (
                    <span className="tag tag-pending">有识别存疑处</span>
                  )}
                  <span className="material-len">{item.text.length} 字</span>
                  <button
                    className="link"
                    onClick={() => {
                      setEditing(editing === item.id ? null : item.id);
                      setEditDraft(item.text);
                    }}
                  >
                    {editing === item.id ? '取消' : '就地纠错'}
                  </button>
                </div>

                {editing === item.id ? (
                  <div className="material-edit">
                    <textarea
                      className="input"
                      rows={5}
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      disabled={wb.anyBusy}
                    />
                    <div className="actions">
                      <button
                        className="btn btn-sm"
                        disabled={wb.anyBusy}
                        onClick={async () => {
                          await wb.correctMaterial(item.id, editDraft);
                          setEditing(null);
                        }}
                      >
                        保存并重建
                      </button>
                      <span className="hint-inline">
                        保存后知识点与依赖关系会按修正后的内容重建，先前的回答会标记「依据已更新」。
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="material-text">{renderText(item)}</p>
                )}
              </li>
            ))}
          </ul>

          <div className="actions">
            <button
              className="btn btn-ghost"
              onClick={wb.startNewStudy}
              disabled={wb.anyBusy}
              title="清空材料、图谱与补充内容，另起一个会话"
            >
              开始新学习
            </button>
            <span className="hint-inline">
              开始新学习会清空材料与 AI 补充内容；补充内容不跨会话迁移（§3.4）。
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * 渲染材料文本，把「识别可能不准」的片段标出来（§2.2）。
 *
 * 有存疑片段时**不截断** —— 截断会让学生看不到被标出的那一段，
 * 也就失去"就地纠错"的落脚点。
 */
function renderText(item: UiMaterial) {
  const text = item.text;
  const spans = item.lowConfidence;
  if (!spans || spans.length === 0) {
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }

  const clamped = spans
    .map((span) => ({
      start: Math.max(0, Math.min(span.start, text.length)),
      end: Math.max(0, Math.min(span.end, text.length)),
      reason: span.reason,
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  if (clamped.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  clamped.forEach((span, index) => {
    if (span.start > cursor) {
      parts.push(<span key={`plain-${index}`}>{text.slice(cursor, span.start)}</span>);
    }
    parts.push(
      <mark key={`low-${index}`} className="low-conf" title={span.reason}>
        {text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = Math.max(cursor, span.end);
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return parts;
}
