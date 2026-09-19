/**
 * 依赖边界规则（拆分阶段 0 · 卡 5 / `D6` 拍板）
 *
 * ### 这一层在防什么
 *
 * 计划书 §3.3 的 `D-10`：「零边界强制」——分层只靠"口头约定 + 文件所有权"，
 * 新人（或 AI）一次深层导入就把边界打破，**没有机械检测**。
 * 本文件就是那个机械检测：把计划书 §8 的分层方向写成可执行规则。
 *
 * ### 阶段 0 一律 `warn`
 *
 * 与 `eslint.config.js` 同理：现存违规是**已知的**（`components/**` 直接 import
 * `hooks/useWorkbench` 的类型＝计划书 `D-05`，属阶段 1–4 的活），
 * 现在设 error 会让命令恒红而被无视。阶段 1 起逐条转 `error`。
 *
 * ### 为什么用 CJS（`.cjs`）
 *
 * 根 `package.json` 是 `"type": "module"`，而 dependency-cruiser 对 ESM 配置的
 * 支持与版本相关（`18.x` 支持但要求 `export default`）。用 `.cjs` 是最稳的一档，
 * 与依赖分析工具的生态适配最好。
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        '循环依赖：两个模块互相 import。表现为"其中一个在运行时是 undefined"，且随打包顺序漂移。',
      severity: 'warn',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-must-not-depend-upwards',
      comment:
        'shared/ 是最底层（纯工具与常量），一旦它反向依赖 components/hooks/features，' +
        '分层就失效了：底层模块将无法被单独复用与测试。计划书 §8 的方向规则。',
      severity: 'warn',
      from: { path: '^apps/web/src/shared/' },
      to: { path: '^apps/web/src/(components|hooks|features|widgets|entities|pages|app)/' },
    },
    {
      name: 'panels-should-not-import-state-internals',
      comment:
        '计划书 D-05：6/6 面板直接 `import type ... from "../hooks/useWorkbench"`，' +
        '依赖方向与"分层"相反（presentation → state internals）。' +
        '**阶段 0 预期会报出来**（这是存量问题，属阶段 1–4 修）；' +
        '它的价值在于阶段 4 改完后这条会自然变空，届时转 error 即为门禁。',
      severity: 'warn',
      from: { path: '^apps/web/src/components/' },
      to: { path: '^apps/web/src/hooks/' },
    },
    {
      name: 'server-must-not-reach-into-web',
      comment: '服务端不得依赖前端源码（反向依赖会让构建拓扑纠缠）。',
      severity: 'error', // 这条没有存量违规，直接设 error —— 一旦出现就是真的错
      from: { path: '^apps/server/src/' },
      to: { path: '^apps/web/' },
    },
  ],
  options: {
    // 只分析我们自己的源码；产物与依赖树会淹没报告
    exclude: {
      path: '(^|/)(node_modules|dist|deploy-dist|\\.learnbuddy)/',
    },
    doNotFollow: { path: '(^|/)(node_modules|dist)/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
};
