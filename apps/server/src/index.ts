/**
 * 服务入口
 *
 * 单 Web 服务，同时提供 /api 接口与静态资源（说明书 5.1）。
 * 密钥只在此侧使用，绝不下发到前端。
 */

import express from 'express';
import { describeModelAdapter, env } from './env.js';
import { apiRouter, errorHandler } from './routes.js';

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
  // 明确打出本次生效的适配器，避免演示或截图时误把 mock 当成真实能力（说明书 9.2）
  console.log(`[server] ${describeModelAdapter()}`);
});
