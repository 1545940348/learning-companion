/**
 * 会话内学习画像（A6）
 *
 * 说明书 §2.1、§2.3 的两条边界：
 * - 画像只做**会话内**呈现，不夸大、不预测；
 * - 「我已掌握」这类自我评估**不改变材料覆盖状态** —— 画像区要如实说明这一点，
 *   否则学生会以为点一下就等于材料覆盖了。
 */

import type { WorkbenchActions, WorkbenchState } from '../hooks/useWorkbench';
import { MISCONCEPTION_LABELS, STATUS_LABELS, statusClass } from '../lib/labels';

type Props = { wb: WorkbenchState & WorkbenchActions };

export function ProfilePanel({ wb }: Props) {
  const profile = wb.profile;
  const mastered = profile ? Object.entries(profile.mastery) : [];

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>学习画像</h2>
        <span className="meta">{profile ? `更新于 ${shortTime(profile.updatedAt)}` : '暂无数据'}</span>
      </header>

      {!wb.sessionId ? (
        <p className="hint">
          轻路径提问不产生材料画像。上传讲义并解析后，这里会记录你的缺口与补充情况。
        </p>
      ) : (
        <>
          <div className="actions">
            <button className="btn btn-ghost btn-sm" onClick={wb.fetchProfile} disabled={wb.isBusy('profile')}>
              {wb.isBusy('profile') ? '读取中…' : '刷新画像'}
            </button>
            <span className="hint-inline">画像只反映本会话，不会跨会话累计。</span>
          </div>

          {mastered.length === 0 ? (
            <p className="hint">
              本会话还没有产生掌握状态条目。当前只有「补上这一段」会写入掌握状态与缺口历史
              —— 练习提交与提问会上报事件，但暂不产生这里的条目（原因见练习面板的说明）。
            </p>
          ) : (
            <ul className="profile-list">
              {mastered.map(([conceptId, status]) => (
                <li key={conceptId} className="profile-row">
                  <code>{conceptId}</code>
                  <span className={statusClass(status)}>{STATUS_LABELS[status]}</span>
                </li>
              ))}
            </ul>
          )}

          {profile && profile.gaps.length > 0 && (
            <div className="gap-block">
              <h3 className="sub">缺口历史</h3>
              <ul className="profile-list">
                {profile.gaps.map((gap) => (
                  <li key={gap.conceptId} className="profile-row">
                    <code>{gap.conceptId}</code>
                    <span className="tag tag-supplemented">
                      {gap.resolvedAt ? `已补于 ${shortTime(gap.resolvedAt)}` : '待补充'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {profile && profile.misconceptions.length > 0 && (
            <div className="gap-block">
              <h3 className="sub">常见误区</h3>
              <ul className="profile-list">
                {profile.misconceptions.map((item) => (
                  <li key={`${item.kind}-${item.pattern}`} className="profile-row">
                    <span className="tag tag-failed">{MISCONCEPTION_LABELS[item.kind]}</span>
                    <span>{item.pattern}</span>
                    <span className="meta">×{item.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="hint-inline">
            说明：上述「AI 已补充」表示内容由系统补齐并显著标注，**不等于已验证**。
            选择「我已掌握，继续」只影响引导顺序，不会把材料未覆盖改判为已覆盖（§2.3）。
          </p>
        </>
      )}
    </section>
  );
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
