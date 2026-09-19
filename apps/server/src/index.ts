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
import { mountSecurityHeaders } from './http/security-headers.js';
import { mountWebApp } from './http/serve-web.js';

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

/*
 * 安全响应头（阶段 0 · 卡 1 / D-01）：**挂在最前面**，让页面、静态资源、/api、
 * 404 与错误响应全都带上（详见 http/security-headers.ts 的说明）。
 * 回滚 = 注释掉这一行。
 */
mountSecurityHeaders(app);

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

// 同源托管前端（说明书 V2.0 · P-C13「前后端同源部署」）：
// 让同一个地址既提供页面、也提供 /api 接口，评委点开一个链接即可使用。
// 目录不存在时不报错、不阻止启动 —— 只调 /api 的后端联调场景下服务照常可用。
const web = mountWebApp(app, { webDistDir: env.webDistDir });
if (web.mounted) {
  console.log(`[server] 网页目录 ${web.webDistDir}`);
}

app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] http://localhost:${env.port}`);
});
