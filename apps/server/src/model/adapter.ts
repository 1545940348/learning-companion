/**
 * 模型适配器的对外契约（`I38`）
 *
 * ### 为什么单独成一个文件
 *
 * `ModelAdapter` 原先定义在 `./index.ts`。默认通道 `./deepseek.ts` 需要这个类型，
 * 于是 `deepseek.ts → index.ts`；而 `index.ts` 为了 `createDeepseekAdapter` 又要
 * `index.ts → deepseek.ts` —— 一个**真正的循环依赖**，被 `dependency-cruiser` 的
 * `no-circular` 规则抓到（2026-09-20 拆环前实测：`1 errors, 6 warnings`）。
 *
 * 循环依赖的危害不在"命令报红"，而在**运行时随求值顺序漂移**：`index.ts` 在模块
 * 顶层就会调用 `createModelAdapter()`，一旦顺序变化，另一侧可能拿到 `undefined`。
 * 这类缺陷不稳定复现，属最坏的一类。
 *
 * ### 修法：共享契约下沉到叶子模块
 *
 * `adapter.ts` **不 import 本项目任何模块**（只依赖 `@lc/teaching` 的类型），
 * 因此 `index.ts` 与 `deepseek.ts` 之间不再有直接边 —— 两边都只依赖本文件。
 * 环消失后，`no-circular` 规则同步转为 `error`（见 `.dependency-cruiser.cjs` 文件头）。
 */

import type { ModelCaller } from '@lc/teaching';

export interface ModelAdapter {
  name: string;
  isMock: boolean;
  call: ModelCaller;
}
