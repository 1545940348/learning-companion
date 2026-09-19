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

import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '@lc/contracts';

/**
 * 服务版本号 —— **运行时读取，取不到报 `null`**（待决策项 `I17` 的落地）
 *
 * ### 原先为什么是错的
 *
 * `/api/health` 的 `version` 是硬编码字符串 `'0.2.0'`，而五个 `package.json` 都是
 * `0.1.0` —— 全仓找不到 `0.2.0` 的任何出处，也没有对应 tag。评委对照源码仓库时
 * 会先看到这个对不上的数字。硬编码的第二个问题是它**不会随包版本升级而变**，
 * 等于把"漂移"写进了代码。
 *
 * ### 现在取哪个口径
 *
 * 取 **`@lc/server` 自己的 `package.json` 版本**（"这个服务是哪个版本"），
 * 与 `builtAt` 同一思路：**取不到就如实报 `null`，绝不编一个看起来合理的数字**。
 * 刻意不做"找不到就退回硬编码"的兜底 —— 那等于把同一个失真换个地方藏起来。
 *
 * 找不到文件的情况是真实存在的：产物态下 `dist/index.js` 相对 `package.json`
 * 只有一层，而源码态的层级不同，故按几个候选位置探测。
 */
export function describeVersion(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../package.json'), // 产物态：dist/index.js 或 dist/config/*.js → ../package.json
    resolve(here, '../../package.json'), // 源码态：src/config/ → ../../package.json
    resolve(process.cwd(), 'package.json'), // 以 apps/server 为工作目录启动
    resolve(process.cwd(), 'apps/server/package.json'), // 以仓库根为工作目录启动
  ];

  for (const file of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { version?: unknown }).version === 'string'
      ) {
        return (parsed as { version: string }).version;
      }
    } catch {
      // 该候选位置不可用（不存在 / 不是合法 JSON）→ 试下一个
    }
  }

  return null;
}

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
