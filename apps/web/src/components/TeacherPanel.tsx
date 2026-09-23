import { TEACHER_MIN_SAMPLE } from '@lc/contracts';
import type { Workbench } from '../app/model/workbench-types';
import { DEMO_CLASS_ID } from '../app/model/workbench-types';

/**
 * 教师视图：班级聚合（`P-A6`，2026-09-23 由"入口不出现"改为实现）。
 *
 * ### 这一屏刻意不做的三件事
 *
 * 1. **不做「选择班级」下拉** —— 服务端**没有班级实体**，`classId` 只是回显值。
 *    给一个只有一项的下拉，会让人以为"有多个班可选"，那是假装有组织关系；
 * 2. **不排名、不列学生** —— 契约对 `ClassAggregate` 的定义就是
 *    「只含计数与概念维度统计，不含个人信息（用例 E17）」，界面也不该绕过去诱导个人数据；
 * 3. **样本不足时不画分布** —— 低于 `TEACHER_MIN_SAMPLE` 只显示样本量与一句说明。
 *    2 个学生的分布画出来会被当成结论，这正是 §11 要求提示「样本不足」的原因。
 *
 * ### 一句话说明它是什么
 *
 * 面板顶部始终写着「演示级：当前所有会话视为一个班」——
 * 这句不是装饰，它决定了这一屏的数据**能被怎么解读**。
 */
export function TeacherPanel({ wb }: { wb: Workbench }) {
  const aggregate = wb.teacher;
  const students = aggregate?.studentCount ?? 0;
  const enough = students >= TEACHER_MIN_SAMPLE;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>教师视图</h2>
        <span className="meta">
          {aggregate
            ? `样本 ${students} 人 · 更新于 ${new Date(aggregate.updatedAt).toLocaleTimeString('zh-CN')}`
            : '尚未读取'}
        </span>
      </header>

      <div className="actions">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void wb.fetchTeacher()}
          disabled={wb.isBusy('teacher')}
        >
          {wb.isBusy('teacher') ? '读取中…' : '刷新'}
        </button>
        {/* 这句是**能力边界的如实标注**：不说明，读者会以为数据来自真实班级 */}
        <span className="hint-inline">演示级：当前所有会话视为一个班（{DEMO_CLASS_ID}）</span>
      </div>

      {!aggregate ? (
        <p className="hint">点「刷新」读取班级聚合</p>
      ) : !enough ? (
        <p className="hint">
          样本不足（{students} / {TEACHER_MIN_SAMPLE}）· 暂不展示分布
        </p>
      ) : (
        <>
          <h3 className="panel-subhead">掌握状态分布</h3>
          <table className="table">
            <thead>
              <tr>
                <th>概念</th>
                <th>已覆盖</th>
                <th>已补充</th>
                <th>未覆盖</th>
                <th>待确认</th>
                <th>已验证</th>
                <th>有争议</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(aggregate.mastery).map(([conceptId, row]) => (
                <tr key={conceptId}>
                  <td>
                    <code>{conceptId}</code>
                  </td>
                  <td>{row.LOCAL}</td>
                  <td>{row.SUPPLEMENTED}</td>
                  <td>{row.MISSING}</td>
                  <td>{row.PENDING}</td>
                  <td>{row.VERIFIED}</td>
                  <td>{row.DISPUTED}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="panel-subhead">常见误区</h3>
          {aggregate.misconceptions.length === 0 ? (
            <p className="hint">暂无误区记录</p>
          ) : (
            <ul className="profile-list">
              {aggregate.misconceptions.map((item) => (
                <li key={`${item.kind}|${item.pattern}`} className="profile-row">
                  <span>{item.pattern}</span>
                  <span className="meta">{item.kind}</span>
                  <span className="tag">{item.count}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="panel-subhead">材料覆盖</h3>
          {aggregate.coverageHeat.length === 0 ? (
            <p className="hint">暂无材料</p>
          ) : (
            <ul className="heat-list">
              {aggregate.coverageHeat.map((item) => (
                <li
                  key={`${item.materialId}|${item.conceptId}`}
                  className={item.covered ? 'heat-row heat-row-on' : 'heat-row'}
                  title={item.covered ? '该材料覆盖此概念' : '该材料未覆盖此概念'}
                >
                  <span>{item.conceptId}</span>
                  <span className="meta">{item.materialId}</span>
                  {/* 用文字而不是只用颜色：色觉差异下也要能读（与"红并入黄"同一条纪律） */}
                  <span className="tag">{item.covered ? '已覆盖' : '未覆盖'}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
