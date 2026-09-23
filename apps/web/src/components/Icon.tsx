/**
 * 内联 SVG 图标集（**不引第三方图标库**）。
 *
 * ### 为什么自己画
 *
 * 项目运行时依赖只有 3 个（`react` / `react-dom` / `@lc/contracts`），引 `lucide-react`
 * 之类会连锁三处：README 依赖声明表、`scripts/check-licenses.mjs` 的三重比对、
 * 打包体积闸门。这里按**经典线性图标**的规格自绘（24 网格、`stroke-width 1.7`、
 * 圆头圆角、`currentColor`），既满足"图标充分且经典"，又不动依赖。
 *
 * 用法：`<Icon name="graph" />` —— 颜色继承当前文字色，尺寸默认 18。
 */

import type { ReactElement } from 'react';

export type IconName =
  | 'chat'
  | 'book'
  | 'bulb'
  | 'graph'
  | 'target'
  | 'chart'
  | 'plus'
  | 'mic'
  | 'image'
  | 'send'
  | 'panel'
  | 'alert'
  | 'check'
  | 'sparkle'
  | 'chevron'
  | 'close'
  | 'refresh'
  | 'stop'
  | 'history'
  | 'users';

const PATHS: Record<IconName, ReactElement> = {
  chat: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </>
  ),
  book: (
    <>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </>
  ),
  bulb: (
    <>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M15.1 14c.2-1 .7-1.7 1.4-2.5A4.7 4.7 0 0 0 18 8a6 6 0 0 0-12 0c0 1 .2 2.2 1.5 3.5A4.6 4.6 0 0 1 8.9 14" />
    </>
  ),
  graph: (
    <>
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="5" r="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="m6.8 17.2 3.4-3.4" />
      <path d="m13.8 10.2 3.4-3.4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.6" />
      <circle cx="12" cy="12" r="1.2" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V11" />
      <path d="M10 20V4" />
      <path d="M16 20v-6" />
      <path d="M2 20h20" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.8" />
      <path d="m21 15-4.6-4.6L7 20" />
    </>
  ),
  send: (
    <>
      <path d="M5 12h13" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  alert: (
    <>
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  check: (
    <>
      <path d="m5 13 4 4L19 7" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </>
  ),
  chevron: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  stop: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 8.5V12l2.8 1.8" />
    </>
  ),
  users: (
    <>
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
      <circle cx="10" cy="8" r="3.2" />
      <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
      <path d="M15.4 5.1a3.2 3.2 0 0 1 0 6.2" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
