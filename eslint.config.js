/**
 * ESLint 配置（拆分阶段 0 · 卡 5 / `D6` 拍板：装 `eslint` + `dependency-cruiser`）
 *
 * ### 阶段 0 的铁律：**只告警，不阻断**
 *
 * 所有规则一律 `warn`。理由：阶段 0 的目标是"让边界被打破时能立刻看见"，
 * 而不是"先把存量问题全部修完"——`useWorkbench.ts` 现在 900 多行、6 个面板都直接
 * import 它的类型，这些是阶段 1–4 的活。若现在就设成 error，`npm run lint` 必然全红，
 * 很快就会被无视，等于白装。**阶段 1 起逐条转 `error`**（计划书 §14.2 ⑥）。
 *
 * ### 为什么用 flat config
 *
 * ESLint 10 只支持 flat config（`eslint.config.js`），旧的 `.eslintrc.*` 已废弃。
 * 根 `package.json` 是 `"type": "module"`，所以这里直接用 ESM 语法。
 */

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    // 产物、依赖、部署包与本地记忆都不该被 lint（它们不是我们的源码）
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'deploy-dist/**',
      '.learnbuddy/**',
      'apps/server/scripts/**/*.d.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mjs,js,jsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      /*
       * 这两条是**真正能防事故**的：hooks 的调用顺序一旦被条件分支破坏，
       * 表现是"某些状态下状态错乱"，比崩掉更难查。仍只告警（阶段 0 口径）。
       */
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 服务端与脚本里有刻意的 console 输出（启动信息），不该被当成问题
      'no-console': 'off',
    },
  },
];
