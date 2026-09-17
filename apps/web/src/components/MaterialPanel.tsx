/**
 * 材料输入与材料列表（A1、A2）
 *
 * 设计取向（说明书 §2.2、§2.4）：
 * - 识别文本**默认可直接使用**，不设"请确认识别结果"的阻断步骤；
 * - 识别不准的地方标「识别可能不准」，学生可就地修改；
 * - 两种上传动作分开：「补充当前材料」保留旧材料与图谱，「开始新学习」另起会话；
 * - 图片与语音入口**如实提示未接入**，不假装已识别（§9）。
 */

import { useRef, useState } from 'react';
import { MATERIAL_LIMITS } from '@lc/contracts';
import type { WorkbenchActions, WorkbenchState } from '../hooks/useWorkbench';
import { totalTextLength } from '../hooks/useWorkbench';

type Props = { wb: WorkbenchState & WorkbenchActions };

const PLACEHOLDER = `把讲义、题目或任何看不懂的段落粘贴到这里。

例如：
判断 f(x) 的单调性时，只需看 f'(x) 的符号：
f'(x) > 0 时函数递增，f'(x) < 0 时函数递减。`;

export function MaterialPanel({ wb }: Props) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const used = totalTextLength(wb.materials);
  const busy = wb.busy === 'knowledge';

  async function handleSubmit() {
    await wb.submitMaterials([draft]);
    setDraft('');
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
      />

      <div className="actions">
        <button className="btn" onClick={handleSubmit} disabled={busy || draft.trim().length === 0}>
          {busy ? '正在解析…' : wb.materials.length > 0 ? '补充当前材料' : '解析这份材料'}
        </button>
        <button className="btn btn-ghost" onClick={handleImagePicked} disabled={busy}>
          上传图片
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={handleImagePicked}
        />
        <span className="count">
          单次 {draft.length} / {MATERIAL_LIMITS.maxSingleInputLength} 字
        </span>
      </div>

      {wb.materials.length > 0 && (
        <>
          <ul className="material-list">
            {wb.materials.map((item, index) => (
              <li key={item.id} className="material-item">
                <div className="material-head">
                  <span className="material-index">材料 {index + 1}</span>
                  {item.corrected && <span className="tag tag-pending">已修正</span>}
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
                    />
                    <div className="actions">
                      <button
                        className="btn btn-sm"
                        disabled={busy}
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
                  <p className="material-text">{preview(item.text)}</p>
                )}
              </li>
            ))}
          </ul>

          <div className="actions">
            <button
              className="btn btn-ghost"
              onClick={wb.startNewStudy}
              disabled={busy}
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

function preview(text: string): string {
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
