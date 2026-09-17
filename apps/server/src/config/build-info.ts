/**
 * 运行形态自证（待办 P-C12）
 *
 * ### 为什么需要它
 *
 * 本项目有一条踩过的坑：**「构建成功」不等于「可运行」**（编号 `B1`）。
 * 部署到平台之后会多出一类同源问题 —— **「链接是活的」不等于「跑的是新产物」**：
 * 平台可能仍在使用上一次的构建，或者实际跑的是源码直跑。
 * 这里让服务自己把这两件事报出来，`verify:dist` 会断言 `mode === 'dist'`，
 * 于是"线上跑的是哪个产物"有了可核对的事实，而不靠人去猜。
 *
 * ### 口径上的两个刻意的选择
 *
 * 1. **只报入口文件名，不报绝对路径**：`/api/health` 是公开接口，
 *    报绝对路径等于公开开发机的目录结构。
 * 2. **时间取不到就报 `null`**：不编一个看起来合理的时间。
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { BuildInfo } from '@lc/contracts';

/** 判定是否运行在构建产物上：入口落在 `dist/` 目录，或显式设了生产环境 */
function detectMode(entryPath: string): BuildInfo['mode'] {
  if (process.env.NODE_ENV === 'production') return 'dist';
  return /(^|[\\/])dist[\\/]/.test(entryPath) ? 'dist' : 'dev';
}

export function describeBuild(): BuildInfo {
  // process.argv[1] 是当前执行的入口脚本：node dist/index.js → 产物；tsx src/index.ts → 源码
  const entryPath = process.argv[1] ?? '';
  const mode = detectMode(entryPath);

  let builtAt: string | null = null;
  if (entryPath.length > 0) {
    try {
      // 产物文件的修改时间即"这个产物是什么时候构建出来的"
      builtAt = statSync(entryPath).mtime.toISOString();
    } catch {
      builtAt = null; // 取不到就如实报 null
    }
  }

  return {
    mode,
    entry: entryPath.length > 0 ? basename(entryPath) : '(unknown)',
    builtAt,
  };
}
