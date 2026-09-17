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
export * from './api.js';
// 模型调用接口（C 实现并注入；供服务端适配层与教学模块共用）
export * from './model.js';
