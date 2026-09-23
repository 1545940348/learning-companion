/**
 * 依赖边界规则（拆分阶段 0 · 卡 5 / `D6` 拍板）
 *
 * ### 这一层在防什么
 *
 * 计划书 §3.3 的 `D-10`：「零边界强制」——分层只靠"口头约定 + 文件所有权"，
 * 新人（或 AI）一次深层导入就把边界打破，**没有机械检测**。
 * 本文件就是那个机械检测：把计划书 §8 的分层方向写成可执行规则。
 *
 * ### 按规则逐条转 `error`（2026-09-20 订正）
 *
 * 原先的写法是"阶段 0 一律 `warn`，阶段 1 起逐条转 `error`"。**订正为：每条规则
 * 在它**自己**清零之后转 `error`**，不等三处告警全清 —— 后者会把门禁推到阶段 4 之后。
 *
 * - `no-circular`：**已于 2026-09-20（`W0-5`/`I38`）清零点，故即转 `error`**。
 *   转之前先确认它"有牙齿"（当时确实报出 `deepseek.ts ↔ model/index.ts` 的环，
 *   命令退出码非 0），拆环后再确认转绿 —— 一次真正的红 → 绿。
 * - `panels-should-not-import-state-internals`：**2026-09-23 清零并转 `error`**（比计划书预估提前）。
 *   原判断是"它要到阶段 4 才自然变空"—— 但**类型与纯函数本就不属于状态层**：
 *   把类型搬到 `apps/web/src/app/model/workbench-types.ts`、把 `shouldOfferRetry` /
 *   `totalTextLength` 搬到 `app/model/{notice,materials}.ts` 之后，这条**当场**就空了。
 *   教训：`D-05` 把它算成"阶段 4 的活"，是按**目录搬迁**算的；
 *   按**依赖方向**算，它是可以立刻修的 —— 这也是本轮 L 档改造的附带收益。
 * - `shared-must-not-depend-upwards`：保持 `warn`（存量已清零，待确认后转）。
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
      // 2026-09-20（W0-5 / I38）：本条已清零 → 转 error。见文件头「按规则逐条转 error」。
      severity: 'error',
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
        '计划书 D-05：面板不得 import 状态层内部（presentation → state internals 是反方向）。' +
        '**2026-09-23 已清零并转 error** —— 类型搬到 `apps/web/src/app/model/workbench-types.ts`、' +
        '纯函数搬到 `app/model/{notice,materials}.ts`，面板不再穿透到 `hooks/`。' +
        '转 error 前做过红/绿验证：临时在 `MaterialPanel.tsx` 加回一句' +
        '`import type { WorkbenchState } from "../hooks/useWorkbench"` → 本条如实报 error 且退出码非 0；' +
        '去掉后回到 0 violations。',
      severity: 'error',
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
