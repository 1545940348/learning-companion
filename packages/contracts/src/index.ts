/**
 * @lc/contracts —— 共享类型与接口契约
 *
 * 前后端唯一事实来源。A、B、C 三人据此并行开发。
 * 任何字段变更都必须同步修改：本包、使用方、`docs/tech` 下的契约变更记录。
 */

export * from './session.js';
export * from './knowledge.js';
export * from './tutor.js';
export * from './quiz.js';
export * from './profile.js';
// 多智能体协作与降级（`P-B8`，E18）
export * from './agents.js';
// 账号与登录（演示级，见 auth.ts 顶部的三条说明）
export * from './auth.js';
export * from './api.js';
// 模型调用接口（C 实现并注入；供服务端适配层与教学模块共用）
export * from './model.js';
