import { useEffect, useState } from 'react';
import type { HealthResponse, TutorResponse } from '@lc/contracts';
import { ApiError, api } from './api';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<TutorResponse | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((error: unknown) => {
        setHealthError(error instanceof Error ? error.message : '无法连接服务端');
      });
  }, []);

  async function handleAsk() {
    const trimmed = question.trim();
    if (trimmed.length === 0 || asking) {
      return;
    }

    setAsking(true);
    setAskError(null);

    try {
      // 轻路径：sessionId 为 null，不要求先上传材料（说明书 2.1）
      const result = await api.ask({
        sessionId: null,
        materialVersion: 0,
        question: trimmed,
        mode: 'explain',
      });
      setAnswer(result);
    } catch (error) {
      setAskError(error instanceof ApiError ? error.message : '请求失败，请稍后重试');
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>微积分学伴</h1>
          <p className="subtitle">导数 · 切线 · 单调性 ｜ 发现前置知识缺口并补上</p>
        </div>
        <div className="status">
          {health && (
            <span className={health.mock ? 'badge badge-warn' : 'badge badge-ok'}>
              {health.modelProvider}
              {health.mock ? '（mock，未配置密钥）' : ''}
            </span>
          )}
          {healthError && <span className="badge badge-err">服务端未连接</span>}
        </div>
      </header>

      <main className="main">
        <section className="card">
          <h2>直接提问</h2>
          <p className="hint">可以不上传材料。粘贴一道题或一句看不懂的讲义，直接问。</p>
          <textarea
            className="input"
            rows={5}
            value={question}
            placeholder="例如：为什么 f'(x) &gt; 0 就能说明函数递增？"
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="actions">
            <button className="btn" onClick={handleAsk} disabled={asking || question.trim().length === 0}>
              {asking ? '正在解答…' : '提问'}
            </button>
            <span className="count">{question.length} / 3000</span>
          </div>
          {askError && <p className="error">{askError}</p>}
        </section>

        {answer && (
          <section className="card">
            <h2>
              回答
              <span className="badge badge-muted">
                {answer.basedOnMaterial ? '基于你的材料' : '未基于你的材料'}
              </span>
            </h2>
            {answer.blocks.map((block, index) => (
              <div className="answer-block" key={index}>
                <p className="answer-text">{block.content}</p>
                <div className="source-row">
                  <span className="source-tag">{describeSource(block.sourceType)}</span>
                  {block.citations.length > 0 && (
                    <span className="cite">引用 {block.citations.length} 处</span>
                  )}
                </div>
              </div>
            ))}
            {answer.nextStep && <p className="hint">下一步：{answer.nextStep.message}</p>}
          </section>
        )}

        <section className="card card-muted">
          <h2>材料路径（待实现）</h2>
          <p className="hint">
            上传讲义后，这里会显示知识点卡片与前置依赖状态。发现缺口时可以直接「补上这一段」，
            不需要你自己去找材料。
          </p>
          <ul className="todo">
            <li>图文输入与就地纠错（A2）</li>
            <li>知识点卡片与四态展示（A3）</li>
            <li>缺口识别与一键补充（A4）</li>
            <li>练习：固定题 ＋ 按材料出题（A5）</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

function describeSource(sourceType: string): string {
  switch (sourceType) {
    case 'material':
      return '来自讲义';
    case 'derived':
      return '基于材料的推导';
    case 'ai-supplement':
      return 'AI 补充：非上传讲义内容';
    default:
      return sourceType;
  }
}
