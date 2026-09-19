import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './app/providers/ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少根节点 #root');
}

createRoot(container).render(
  <StrictMode>
    {/* 阶段 0 卡 2：任一组件渲染抛错时只显示兜底提示，不再整页白屏（D-02） */}
    <ErrorBoundary label="学习工作台">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
