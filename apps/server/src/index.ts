/**
 * 服务入口
 *
 * 单 Web 服务，同时提供 /api 接口与静态资源（说明书 5.1）。
 * 密钥只在此侧使用，绝不下发到前端。
 *
 * 启动前先做模型配置校验（config/env.ts 的 validateModelConfig）：
 * 配置不完整时**明确报错并退出**，不静默降级到其他通道（说明书 V1.4）。
 * 注意这是"主动拒绝启动"，不是崩溃 —— 运行时的模型失败由适配层捕获为 ModelError，
 * 不会让进程退出。
 */

import express from 'express';
import { describeModelAdapter, env, validateModelConfig } from './config/env.js';
import { apiRouter, errorHandler } from './http/routes.js';

// 日志先打出实际通道，再报告配置问题 —— 顺序刻意如此，便于一眼看清"用的是什么、缺什么"
console.log(`[server] ${describeModelAdapter()}`);

const problems = validateModelConfig();
if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`[server] ✗ ${problem}`);
  }
  console.error(
    '[server] 模型配置不完整，已退出。按说明书 V1.4，缺少密钥时不静默切换通道；' +
      '仅本地开发可显式设 MODEL_PROVIDER=mock。',
  );
  process.exit(1);
}

const app = express();

// 图片以 base64 传输，上限按 5MB 图片留出余量（说明书 2.2）
app.use(express.json({ limit: '8mb' }));

// 开发期 CORS：Vite 通过代理访问，正常不需要开启；
// 若前端直连本服务，可解开下面的注释。
// app.use((_req, res, next) => {
//   res.setHeader('Access-Control-Allow-Origin', '*');
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//   res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
//   next();
// });

app.use('/api', apiRouter);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] http://localhost:${env.port}`);
});
