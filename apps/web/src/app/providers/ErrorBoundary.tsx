/**
 * 渲染兜底（拆分阶段 0 · 卡 2 / 缺陷 `D-02`）
 *
 * ### 为什么必须有它
 *
 * 原先 `main.tsx` 直接 `createRoot(...).render(<App />)`，**没有任何错误边界**：
 * 任一组件在渲染期抛错，React 会卸载整棵树 → **整页白屏**，且控制台之外没有任何提示。
 * 演示场景里最容易触发的是"模型返回的结构与预期不齐"（例如少一个字段、
 * 类型从对象变成字符串），一旦发生，评委会看到一个空白页面而不是"这里出错了"。
 *
 * ### 为什么用类组件
 *
 * `getDerivedStateFromError` / `componentDidCatch` 目前**只有类组件能实现**
 * （React 没有函数组件版的错误边界 hook）。这是刻意写的类，不是"没跟上新写法"。
 *
 * ### 兜底 UI 的三条要求
 *
 * 1. **说清是哪个区域出错**（`label`），不要只说"出错了" —— 否则排查等于从零开始；
 * 2. **给出可执行的下一步**（重新加载）；不提供"忽略"按钮 —— 状态可能已经不一致，
 *    "假装没事"比白屏更危险；
 * 3. **如实说明不会上传任何东西**：本项目没有前端错误上报端点（`T-10` 拍板不新增），
 *    所以不能说"错误已上报" —— 那会是一句无据声明（与 `I20⑦`/`I33` 同类）。
 *
 * ### 阶段 0 的范围
 *
 * 先包**整页一层**。逐面板包裹属阶段 4（widget 改造时一起做）——
 * 现在包细了，阶段 4 还要再改一遍。
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 出错区域的名称，用于兜底文案（如"学习工作台"） */
  label: string;
}

interface State {
  hasError: boolean;
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, message: null };

  /**
   * 由 React 在渲染期捕获错误后调用。
   *
   * ⚠️ 抽成 static 方法（React 就是这么调的）：`verify:render` 用 `react-dom/server`，
   * 而 **SSR 下错误边界不生效**（`renderToStaticMarkup` 遇错直接抛，不走这里）——
   * 所以冒烟脚本里不能写"渲染一个会抛错的子组件、断言兜底文案出现"，
   * 那条断言要么假失败、要么被绕过后恒真。改为直接调本方法做纯逻辑断言。
   */
  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  /**
   * 只写控制台，不上报任何地方。
   *
   * 为什么不发请求：本项目没有前端错误上报端点（`T-10` 决定不新增 `/api/telemetry`），
   * 且"加了登录之后日志/上报可能带用户名"会让这件事更敏感（计划书 `T-05`）。
   * 若将来要做，必须同时处理脱敏与鉴权，不能在这里顺手加一个 `fetch`。
   */
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}] 渲染出错`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="notice notice-error" role="alert">
        <span>
          <strong>{this.props.label}在渲染时出错了，页面其余部分仍然可用。</strong>
          <br />
          出错信息：{this.state.message ?? '（无）'}
          <br />
          可以点下面的按钮重新加载；如果反复出现，请把上面这行信息记下来。
          <strong>本次错误只写在本机控制台，不会上传到任何地方。</strong>
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            window.location.reload();
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
