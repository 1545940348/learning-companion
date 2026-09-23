/**
 * 材料输入与材料列表（A1、A2）
 *
 * 设计取向（说明书 §2.2、§2.4）：
 * - 识别文本**默认可直接使用**，不设"请确认识别结果"的阻断步骤；
 * - 识别不准的地方标「识别可能不准」，学生可就地修改；
 * - 两种上传动作分开：「补充当前材料」保留旧材料与图谱，「开始新学习」另起会话；
 * - **图片入口已接入**（2026-09-21）：图片由**服务端**识别为文本后按普通材料提交；
 * - **语音入口已接入**（2026-09-22）：语音由**浏览器**转成文字后填入输入框，
 *   学生看一眼、可以就地改，再点「解析这份材料」才提交。
 *   两条路径最后都变成**普通文本**，与手打材料走同一条下游管道。
 *   ⚠️ 识别发生在浏览器、**不在服务端**（`D3`），界面必须写明这一点，
 *   不得声称服务端具备语音识别能力。
 */

import { useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { MATERIAL_LIMITS } from '@lc/contracts';
import type { UiMaterial, WorkbenchActions, WorkbenchState } from '../app/model/workbench-types';
import { totalTextLength } from '../app/model/materials';
import { VoiceInputButton } from './VoiceInputButton';

type Props = { wb: WorkbenchState & WorkbenchActions; mock: boolean };

const PLACEHOLDER = `把讲义、题目或任何看不懂的段落粘贴到这里。

例如：
判断 f(x) 的单调性时，只需看 f'(x) 的符号：
f'(x) > 0 时函数递增，f'(x) < 0 时函数递减。`;

/**
 * 尚未接入的识别通道 → 面向学生的说明（**不假装已解析**）。
 *
 * ⚠️ **不含 `formula`**（2026-09-22 修正）：公式**不是**"未接入的通道" ——
 * 图片路径早已把 LaTeX 识别出来（只是原先被前端丢掉，见 `useWorkbench` 的 `formulas`），
 * 而纯文字输入**压根没有"识别公式"这一环**。
 * 把它列在这里的后果：纯文字输入**必然**显示「公式识别（LaTeX）未接入」，
 * 图片里本来没有公式（纯叙述段落）时也显示 —— 两处都是假话（用户当场指正）。
 *
 * 约定（别再来一次）：**"能力有没有"用这张表说，"本次有没有结果"用材料条目上的说明说。**
 * `image` 同理已接入，留在这里只为兼容更早的服务端快照（新响应不会再带它）。
 */
const UNAVAILABLE_TEXT: Record<string, string> = {
  image: '图片识别',
  audio: '语音转写',
};

export function MaterialPanel({ wb, mock }: Props) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const used = totalTextLength(wb.materials);
  const parsing = wb.isBusy('knowledge');
  const hasMaterials = wb.materials.length > 0;

  async function handleSubmit() {
    // 只有成功才清空输入框 —— §5.4 要求失败时保留学生的输入
    const ok = await wb.submitMaterials([draft]);
    if (ok) setDraft('');
  }

  /** 图片入口（按钮）：打开文件选择框 */
  function openImagePicker() {
    fileRef.current?.click();
  }

  /**
   * 图片入口（选好文件后）：交给**服务端**识别（`capabilities.image.available` 为真）。
   *
   * 先清空 `input.value`：否则连续选择**同一个文件**不会再触发 `change`，
   * 学生"重试同一张图"时界面会毫无反应（这类静默无响应最难排查）。
   */
  function handleImagePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    void wb.submitImage(file);
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
        <button className="btn btn-ghost" onClick={openImagePicker} disabled={wb.anyBusy}>
          上传图片
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={handleImagePicked}
        />
        {/*
          语音入口。识别结果**只填入输入框，不自动提交** —— 中文语音识别错字多，
          直接提交会污染整份材料的图谱；学生看一眼、可就地改，再点「解析这份材料」。
          （图片路径是自动提交的，两条路径在这点上不同，是有意为之，不是遗漏。）
        */}
        <VoiceInputButton
          disabled={wb.anyBusy}
          onTranscript={(text) =>
            // 追加而不是覆盖：输入框里已有的内容不能被语音冲掉（`I14`：不静默丢内容）
            setDraft((prev) => (prev.trim().length > 0 ? `${prev}\n${text}` : text))
          }
        />
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

                {/*
                  图片材料才有的公式区（`UiMaterial.formulas`，2026-09-22 接入）。
                  **两种结果说法不同，不许混**：
                  · 有公式 → 列出 LaTeX **源码**（本版不做排版渲染，故不引依赖）；
                  · 空数组 → 说清"本次没找到"，并**明确指出这不是"通道没接"** ——
                    否则学生（和评委）会把它读成功能缺失。
                  手打材料是 `undefined`，这里一个字都不显示。
                */}
                {item.formulas !== undefined &&
                  (item.formulas.length > 0 ? (
                    <div className="material-formulas">
                      <span>图片里识别到的公式（LaTeX 源码，本版不做排版）：</span>
                      {item.formulas.map((latex, index) => (
                        <code key={`formula-${index}`}>{latex}</code>
                      ))}
                    </div>
                  ) : (
                    <p className="hint-inline">
                      这张图里没有识别到公式 —— 这是「本次」识别的结果，不是「公式通道没接」。
                    </p>
                  ))}
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
