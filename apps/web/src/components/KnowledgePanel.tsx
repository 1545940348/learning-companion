/**
 * 知识点卡片与前置依赖六态（A3）
 *
 * 说明书 §2.3 的两条关键约束：
 * - 卡片下方直接给出「这部分需要 X 知识，当前材料没有解释」与补充入口，
 *   不把补齐工作交回学生；
 * - 三态之外新增的 `VERIFIED` / `DISPUTED` 只做**如实呈现**，
 *   不因为"已验证"就把 AI 补充内容的标注去掉（§4.3：AI 补充始终显著标注，不降权）。
 */

import { useState } from 'react';
import type { Citation, KnowledgePoint, PrerequisiteRelation } from '@lc/contracts';
import { KNOWLEDGE_CARD_RANGE } from '@lc/contracts';
import type { GapRecord, WorkbenchActions, WorkbenchState } from '../hooks/useWorkbench';
import {
  NEEDS_SUPPLEMENT,
  SOURCE_LABELS,
  STATUS_HINTS,
  STATUS_LABELS,
  VERIFICATION_LABELS,
  statusClass,
  verificationClass,
} from '../lib/labels';

type Props = { wb: WorkbenchState & WorkbenchActions };

export function KnowledgePanel({ wb }: Props) {
  const knowledge = wb.knowledge;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>知识点与前置依赖</h2>
        {knowledge && (
          <span className="meta">
            {knowledge.points.length} 个知识点 · {knowledge.prerequisites.length} 条前置关系
          </span>
        )}
      </header>

      {!knowledge ? (
        <p className="hint">
          还没有解析材料。粘贴一段讲义后，这里会出现 {KNOWLEDGE_CARD_RANGE.min}—
          {KNOWLEDGE_CARD_RANGE.max} 张知识点卡片，并指出其中哪些前置知识你的材料没有讲。
        </p>
      ) : (
        <>
          <div className="card-grid">
            {knowledge.points.map((point) => (
              <PointCard key={point.id} point={point} />
            ))}
          </div>

          {knowledge.points.length === 0 && (
            <p className="hint">
              这段材料里没有抽出可用的知识点。可能是内容与课程范围（导数 / 切线 / 单调性）无关。
            </p>
          )}

          {knowledge.prerequisites.length > 0 && (
            <div className="gap-block">
              <h3 className="sub">前置依赖</h3>
              {knowledge.prerequisites.map((relation) => (
                <RelationRow
                  key={relation.conceptId}
                  relation={relation}
                  gap={wb.gaps[relation.conceptId]}
                  busy={wb.isBusy('gap')}
                  onSupplement={() => wb.supplementGap(relation.conceptId, relation.reason)}
                  onClaimKnown={() => wb.claimKnown(relation.conceptId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ==================== 知识点卡片 ==================== */

function PointCard({ point }: { point: KnowledgePoint }) {
  const [openCitation, setOpenCitation] = useState<number | null>(null);

  return (
    <article className="kp-card">
      <header className="kp-head">
        <h3>{point.name}</h3>
        <span className={verificationClass(point.verification)}>
          {VERIFICATION_LABELS[point.verification]}
        </span>
      </header>

      <p className="kp-explain">{point.explanation}</p>

      {point.formula && (
        <p className="kp-formula">
          <span className="kp-label">公式</span>
          {point.formula}
        </p>
      )}
      {point.conditions && (
        <p className="kp-conditions">
          <span className="kp-label">适用条件</span>
          {point.conditions}
        </p>
      )}

      {point.misconceptions && point.misconceptions.length > 0 && (
        <div className="kp-misconceptions">
          <span className="kp-label">常见误区</span>
          <ul>
            {point.misconceptions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 依据默认收进「依据详情」，不占据正文（§4.3 界面层降权） */}
      <CitationRow
        citations={point.citations}
        openIndex={openCitation}
        onToggle={(index) => setOpenCitation(openCitation === index ? null : index)}
      />
    </article>
  );
}

/* ==================== 前置依赖行 ==================== */

function RelationRow({
  relation,
  gap,
  busy,
  onSupplement,
  onClaimKnown,
}: {
  relation: PrerequisiteRelation;
  gap: GapRecord | undefined;
  busy: boolean;
  onSupplement: () => void;
  onClaimKnown: () => void;
}) {
  const status = gap ? gap.status : relation.status;
  const needsSupplement = NEEDS_SUPPLEMENT.includes(status);
  const [openCitation, setOpenCitation] = useState<number | null>(null);

  return (
    <div className={`relation relation-${status.toLowerCase()}`}>
      <div className="relation-head">
        <strong>{relation.conceptName}</strong>
        <span className={statusClass(status)}>{STATUS_LABELS[status]}</span>
        {gap && (
          <span className={verificationClass(gap.verification)}>
            {VERIFICATION_LABELS[gap.verification]}
          </span>
        )}
      </div>

      <p className="relation-reason">{relation.reason}</p>
      <p className="relation-hint">{STATUS_HINTS[status]}</p>

      {needsSupplement && (
        <div className="actions">
          <button className="btn btn-sm" onClick={onSupplement} disabled={busy}>
            {busy ? '正在生成…' : '补上这一段'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onClaimKnown} disabled={busy}>
            我已掌握，继续
          </button>
          <span className="hint-inline">
            不点就不会生成任何 AI 补充内容；点了之后这段内容只在本会话有效。
          </span>
        </div>
      )}

      {gap && (
        <div className="supplement">
          {/* AI 补充内容始终显著标注，不被"依据详情"收起来（§4.3 例外条款） */}
          <div className="supplement-banner">AI 补充：非上传讲义内容</div>
          <p className="supplement-text">{gap.content}</p>
          <div className="supplement-meta">
            <span className={verificationClass(gap.verification)}>
              验证状态：{VERIFICATION_LABELS[gap.verification]}
            </span>
            {gap.verification === 'unverified' && (
              <span className="hint-inline">
                未经验证的内容不要当成定论；验证引擎接入后会补上校验结果。
              </span>
            )}
          </div>
        </div>
      )}

      <CitationRow
        citations={relation.evidence}
        openIndex={openCitation}
        onToggle={(index) => setOpenCitation(openCitation === index ? null : index)}
      />
    </div>
  );
}

/* ==================== 引用角标 + 依据详情 ==================== */

function CitationRow({
  citations,
  openIndex,
  onToggle,
}: {
  citations: Citation[];
  openIndex: number | null;
  onToggle: (index: number) => void;
}) {
  if (citations.length === 0) {
    return <p className="citation-empty">暂无引用来源</p>;
  }

  const active = openIndex === null ? null : citations[openIndex];

  return (
    <div className="citation-row">
      <span className="citation-label">依据</span>
      {citations.map((citation, index) => (
        <button
          key={`${citation.refId}-${index}`}
          className={index === openIndex ? 'cite-badge cite-active' : 'cite-badge'}
          onClick={() => onToggle(index)}
          title={SOURCE_LABELS[citation.sourceType]}
        >
          {index + 1}
        </button>
      ))}

      {active && (
        <div className="citation-detail">
          <div>
            <span className="kp-label">来源类别</span>
            {SOURCE_LABELS[active.sourceType]}
          </div>
          <div>
            <span className="kp-label">来源编号</span>
            <code>{active.refId}</code>
          </div>
          <div>
            <span className="kp-label">引用片段</span>
            {active.excerpt.length > 0 ? active.excerpt : '（未附摘录）'}
          </div>
        </div>
      )}
    </div>
  );
}
