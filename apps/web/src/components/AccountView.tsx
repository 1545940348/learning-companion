import { useState } from 'react';
import { DEMO_PASSWORD_HINT } from '@lc/contracts';
import type { Workbench } from '../app/model/workbench-types';
import { Icon } from './Icon';

/**
 * 用户页（2026-09-23）：**独立于学习工作台的一页**。
 *
 * ### 为什么全屏、不进 `AppShell`
 *
 * 工作台左栏那一组（材料 / 知识点 / 图谱 / 练习 / 画像 / 教师）是**学习与教学动作**；
 * 而这一页是**账号本身**（登录、身份、退出）。塞进同一个壳里会让人以为
 * "用户页也是学习流程里的一步"。所以它在 `App` 里**先于 `AppShell` 分支**，
 * 自带一个顶部栏（含"返回工作台"）。
 *
 * ### 未登录时这一页就是登录页
 *
 * 登录成功后**原地**变成用户信息页 —— 不做跳转：对一个演示应用来说
 * "登录完该去哪"没有信息量，多一次跳转只是多一次可能的失败。
 *
 * ### 演示账号必须写在明面上
 *
 * 口令来自服务端环境变量（缺省 `demo`），**仓库里不存明文**。
 * 把缺省值写在登录表单下方不是"泄露"，而是**唯一能让演示者知道该输什么**的办法；
 * 不写才会出现"演示时对着登录框愣住"。
 */
export function AccountView({ wb, onBack }: { wb: Workbench; onBack: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const busy = wb.isBusy('auth');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await wb.login(username.trim(), password)) {
      setPassword('');
    }
  };

  return (
    <div className="account-page">
      <header className="account-top">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <Icon name="back" size={16} />
          返回工作台
        </button>
        <h1>我的账号</h1>
        <span className="meta">{wb.account ? wb.account.displayName : '未登录'}</span>
      </header>

      <div className="account-body">
        {wb.account ? (
          <>
            <section className="panel account-card">
              <header className="panel-head">
                <h2>{wb.account.displayName}</h2>
                <span className="meta">{wb.account.role === 'teacher' ? '教师' : '学生'}</span>
              </header>
              <dl className="kv">
                <dt>用户名</dt>
                <dd>{wb.account.username}</dd>
                <dt>角色</dt>
                <dd>{wb.account.role === 'teacher' ? '教师' : '学生'}</dd>
                <dt>班级</dt>
                <dd>{wb.account.classId}</dd>
                <dt>登录时间</dt>
                <dd>{new Date(wb.account.signedInAt).toLocaleString('zh-CN')}</dd>
              </dl>
            </section>

            <section className="panel">
              <header className="panel-head">
                <h2>延展功能</h2>
                <span className="meta">按角色开放</span>
              </header>
              <ul className="account-actions">
                <li>
                  <div>
                    <strong>教师端</strong>
                    <span className="hint-inline">
                      班级聚合：掌握状态分布、常见误区、材料覆盖（只含计数，不含个人信息）
                    </span>
                  </div>
                  {wb.account.role === 'teacher' ? (
                    <button className="btn btn-sm" onClick={onBack}>
                      进入
                    </button>
                  ) : (
                    /* 如实说明为什么不可用，而不是把入口藏掉让人以为"没有这个功能" */
                    <span className="tag">仅教师账号</span>
                  )}
                </li>
              </ul>
            </section>

            <section className="panel">
              <header className="panel-head">
                <h2>会话</h2>
              </header>
              <div className="actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void wb.logout()} disabled={busy}>
                  {busy ? '处理中…' : '退出登录'}
                </button>
                <span className="hint-inline">
                  账号与令牌都是「演示级」：服务端重启后需要重新登录
                </span>
              </div>
            </section>
          </>
        ) : (
          <section className="panel account-card">
            <header className="panel-head">
              <h2>登录</h2>
              <span className="meta">演示级账号</span>
            </header>
            <form className="account-form" onSubmit={submit}>
              <label>
                用户名
                <input
                  className="input"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="student 或 teacher"
                />
              </label>
              <label>
                口令
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="演示口令"
                />
              </label>
              <button className="btn btn-sm" type="submit" disabled={busy || !username || !password}>
                {busy ? '登录中…' : '登录'}
              </button>
            </form>
            <p className="hint">
              演示账号：<code>student</code>（学生）、<code>teacher</code>（教师）；
              口令缺省为 <code>{DEMO_PASSWORD_HINT}</code>，可由服务端环境变量改写。
            </p>
            <p className="hint-inline">
              不登录也能直接用学习工作台 —— 账号只影响这一页的显示与教师端入口。
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
