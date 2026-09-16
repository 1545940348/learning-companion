# 微积分学伴

> 面向一元函数微分学的多模态教学智能体 —— 覆盖 **导数 / 切线 / 单调性**

参赛项目：深大计软 & 腾讯云 粤港澳大湾区 AI Coding 创新大赛 · **方向一「AI + 教学管理助手」**

---

## 这是什么

一个帮大学生读懂微积分讲义的教学助手。

和普通 AI 答疑的根本区别：普通工具只回答你问的那个问题；微积分学伴会在回答之前先检查——**你上传的讲义里，有没有解释你这个知识点所依赖的前置概念**。发现缺口时，系统直接补上最小必要说明，而不是把补齐的工作交回给你。

> **核心命题**：先回答学生问的问题；当他问不出来的时候，替他找出缺的那一块并补上。

## 核心机制

| 机制 | 说明 |
|---|---|
| **零门槛提问** | 不上传材料也能提问，拍照或粘贴即可得到解释；上传讲义后可获得更贴合材料的解答 |
| **轻量知识依赖** | 只建模"学习当前知识点前需要了解什么"，不做复杂图谱。四态：`LOCAL` 材料已覆盖 / `SUPPLEMENTED` 已由 AI 补充 / `MISSING` 材料未覆盖 / 待确认 |
| **缺口即补** | 发现缺口时同屏提供"补上这一段"，由系统生成 200—400 字的最小必要说明并显著标注 |
| **来源可溯** | 三类来源：① 讲义原文 ② 基于材料的解释推导 ③ AI 补充。界面默认简洁，依据可展开查看；AI 补充内容始终显著标注 |
| **边界诚实** | 部分可答则分开回答；超出课程范围则说明并引导；不编造讲义引用，不静默补齐 |

## 技术架构

```
apps/web          React + TypeScript      交互层
packages/teaching 独立 TypeScript 模块     提示词 / 依赖分析 / 缺口补充 / 输出校验
packages/contracts 共享类型与契约
apps/server       Node.js + TypeScript    模型适配 / 会话 / 部署
```

单仓库、单 Web 服务。**不使用向量数据库**，不引入图数据库或嵌入模型。

### 接口契约

| 接口 | 用途 |
|---|---|
| `POST /api/parse` | 文字 / 图片 → 识别文本（可直接使用）、低置信度标记 |
| `POST /api/knowledge` | 材料与补充块 → 知识点、前置关系与来源 |
| `POST /api/tutor` | 提问 → 分块回答、来源、下一步（材料版本可为空，表示零材料提问） |
| `POST /api/gap` | 缺口概念 → 最小必要补充内容、补充块 ID、更新后的依赖状态 |
| `GET /api/quiz?topic=&source=fixed\|material` | 固定题，或基于当前材料生成题 |

## 快速开始

```bash
cp .env.example .env    # 填入 CODEBUDDY_API_KEY
npm install
npm run build           # tsc -b，构建 packages/contracts 与 apps/server
```

模型调用自检（不联网、不消耗额度）：

```bash
npm run smoke:model:selfcheck
```

三条真实调用验证命令（会消耗账户额度）：

```bash
npm run smoke:model:text                  # 纯文字
npm run smoke:model:structured            # 结构化输出（json_schema）
npm run smoke:model:image -- <图片路径>    # 含图片，PNG/JPEG，≤5MB
```

> 密钥只保存在服务端环境变量中，**不要提交 `.env`**，也不要在对话或文档中粘贴密钥原文。

### 模型调用方式

模型推理通过 **CodeBuddy Agent SDK**（`@tencent-ai/agent-sdk`）调用。认证由 SDK 读取环境变量完成，
**不配置 HTTP 端点，也不固定模型名** —— 模型由上游按输入类型自动选择。
选型理由、实测事实与已知限制见 `docs/tech/2026-09-16-模型接入-CodeBuddy Agent SDK.md`。

## 目录结构

```
apps/
  server/          Node.js + TypeScript：模型适配、会话与部署
packages/
  contracts/       共享类型与契约
docs/
  plans/          每轮开发计划
  changelogs/     每轮变更记录
  reviews/        每轮评审记录（含对 AI 输出的否决与修改）
  tech/           技术决策记录
  微积分学伴_项目说明书.md        项目说明书（工作正本）
  大湾区AI_Coding创新大赛_赛事手册.md
  赛题意图与产品设计分析.md
```

> `apps/web`（A）与 `packages/teaching`（B）尚未建立。

## 开发文档留痕

本项目采用四类开发文档记录开发过程，与 LearnBuddy 对话记录互相溯源，命名 `YYYY-MM-DD-<主题>.md`：

- `docs/plans/` — 每轮开始前：目标、任务分解、验收条件
- `docs/changelogs/` — 每轮结束后：改了什么、为什么、影响模块、验收结论
- `docs/reviews/` — 每轮结束后：AI 输出核对结果，**必须包含被否决或被修改的记录**
- `docs/tech/` — 重大决策：选型、契约变更、取舍理由、已知限制

## 团队分工

| 成员 | 负责 |
|---|---|
| A | 前端交互 `apps/web` |
| B | 教学智能 `packages/teaching` |
| C | 服务、契约与部署 `apps/server`、`packages/contracts` |

## 当前状态

**开发中（第 2 轮）。** 说明书已定稿至 V1.2。

| 模块 | 状态 |
|---|---|
| `packages/contracts` | 模型调用接口已冻结；五接口契约待第 3 轮补齐 |
| `apps/server` 模型适配层 | 已完成，工具链验证通过；**真实模型调用尚未端到端验收** |
| `apps/server` 五接口与部署 | 未开始 |
| `apps/web`（A） | 未开始 |
| `packages/teaching`（B） | 未开始 |

本仓库中标注为"设计"或"后续迭代"的能力尚未实现，请勿视为已完成功能。

## 第三方依赖声明

按赛事手册 8.2 要求注明所使用的开源框架与第三方库。

| 依赖 | 版本 | 用途 | 许可 |
|---|---|---|---|
| `@tencent-ai/agent-sdk` | ^0.3.259 | 模型推理调用（CodeBuddy Agent SDK） | MIT |
| `typescript` | ^5.7.2 | 构建与类型检查 | Apache-2.0 |
| `@types/node` | ^22.10.2 | Node.js 类型定义 | MIT |

前端与教学模块依赖在对应模块建立后补充。

## 开源协议

本项目采用 [MIT License](./LICENSE)。

## 致谢

- 深圳大学计算机与软件学院、腾讯云、腾讯教育 —— 赛事主办与协办
- 腾讯 LearnBuddy —— 赛事指定开发平台
