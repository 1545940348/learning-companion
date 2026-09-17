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
| `POST /api/session` | 创建会话，返回初始材料版本 0 |
| `POST /api/parse` | 文字 / 图片 → 识别文本（可直接使用）、低置信度标记 |
| `POST /api/knowledge` | 材料与补充块 → 知识点、前置关系与来源 |
| `POST /api/tutor` | 提问 → 分块回答、来源、下一步（材料版本可为空，表示零材料提问） |
| `POST /api/gap` | 缺口概念 → 最小必要补充内容、补充块 ID、更新后的依赖状态 |
| `GET /api/quiz?topic=&source=fixed\|material` | 固定题，或基于当前材料生成题 |

## 快速开始

```bash
npm install
cp apps/server/.env.example apps/server/.env
# 编辑 apps/server/.env，填入 DEEPSEEK_API_KEY
npm run dev
```

> 密钥只保存在服务端 `apps/server/.env`，已被 `.gitignore` 排除，**不要提交**。
> ⚠️ **`apps/server/.env.example` 会随仓库提交、评委可见，请勿在其中填入真实密钥。**

**只做本地开发、没有密钥时**，显式启用 mock 即可跑通完整流程（冒烟测试见 `apps/server/scripts/smoke.mjs`）：

```bash
MODEL_PROVIDER=mock npm run dev -w @lc/server
```

### 模型通道

| `MODEL_PROVIDER` | 通道 | 说明 |
|---|---|---|
| `deepseek`（**默认**） | DeepSeek API | HTTP 适配器，OpenAI 兼容格式。依据说明书 V1.4 |
| `sdk` | CodeBuddy Agent SDK | **历史接入**，须显式启用，不参与自动降级 |
| `mock` | 假数据 | 仅供本地开发 |

**三档之间没有任何自动降级，也没有 `auto` 档。** 缺密钥或模型失败时明确报错，
不静默切换到其他通道。配置不完整时服务**拒绝启动**并打印缺失项。

选型依据、实测事实与历史决策见：

- `docs/tech/2026-09-17-模型通道-主路与备选.md`（含 V1.3 → V1.4 的反转记录）
- `docs/tech/2026-09-16-模型接入-CodeBuddy Agent SDK.md`

模型通道的自检与调用验证：

```bash
npm run smoke:model:selfcheck -w @lc/server                # SDK 通道自检，不消耗额度
npm run smoke:model:text -w @lc/server                     # SDK 通道纯文字调用
npm run smoke:model:image -w @lc/server -- <图片路径>       # SDK 通道含图片调用（PNG/JPEG，≤5MB）
npm run smoke:model:deepseek -w @lc/server                 # 默认通道单次文字调用，需 DEEPSEEK_API_KEY
```

## 目录结构

```
apps/web/           React 前端：交互层（A）
apps/server/        Node 服务端：模型适配、会话、接口（C）
packages/contracts  共享契约类型，前后端唯一事实来源
packages/teaching   教学模块：提示词、依赖判定、缺口补充、校验、题目（B）

docs/
  plans/          每轮开发计划
  changelogs/     每轮变更记录
  reviews/        每轮评审记录（含对 AI 输出的否决与修改）
  tech/           技术决策记录
  微积分学伴_项目说明书.md        项目说明书（工作正本）
  大湾区AI_Coding创新大赛_赛事手册.md
  赛题意图与产品设计分析.md
```

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

**骨架可运行。** 说明书已更新至 **V1.4**；前后端骨架已搭建，接口冒烟测试 29 项通过。

业务能力尚未实现：缺口判定的固定规则、按材料出题，以及大部分前端交互仍为占位。

**模型适配层已完成，两个真实通道均通过真实密钥验收**（文字与图片调用都实测通过）：

- **默认通道 DeepSeek**：文字 1213 毫秒、图片 3195 毫秒（同轮实测，明细见
  `docs/changelogs/2026-09-17-C-DS转为默认通道.md`）
- 历史接入 CodeBuddy Agent SDK：文字 12–21 秒、图片 17.7 秒（正是 V1.4 改以 DS 为默认的原因）

通道由 `MODEL_PROVIDER` 控制，默认 `deepseek`。**没有自动降级**：缺密钥或模型失败时明确报错，
配置不完整时服务拒绝启动并打印缺失项 —— 不静默切换通道。

错误响应统一经 `apps/server/src/http/error-response.ts` 出口：状态码与 `retryable` 由
**唯一一张表**按错误码推导，不在各分支里写死 —— 同一个契约错误码在入口校验与提交复核
两条路径上给出完全相同的状态码与是否可重试。

本仓库中标为"设计"或"后续迭代"的能力，请勿视为已完成功能。

## 第三方依赖声明

按赛事手册 8.2 要求注明所使用的开源框架与第三方库（实际锁定版本见各 workspace 的 `package.json`）。

| 依赖 | 版本 | 用途 | 许可 |
|---|---|---|---|
| `@tencent-ai/agent-sdk` | ^0.3.259 | 模型推理调用（CodeBuddy Agent SDK） | MIT |
| `express` | ^4.21.0 | HTTP 服务（`apps/server`） | MIT |
| `dotenv` | ^16.4.0 | 服务端环境变量加载 | BSD-2-Clause |
| `react` / `react-dom` | ^19.0.0 | 前端框架（`apps/web`） | MIT |
| `vite` | ^6.0.0 | 前端构建与开发服务器 | MIT |
| `tsx` | ^4.19.0 | 开发期 TypeScript 运行器 | MIT |
| `tsup` | ^8.3.0 | 服务端构建 | MIT |
| `typescript` | ^5.7.0 | 构建与类型检查 | Apache-2.0 |

第三方推理接口的使用方式以赛事方最终答复为准（见 `docs/tech` 模型接入记录的待办项）。

## 开源协议

本项目采用 [MIT License](./LICENSE)。

## 致谢

- 深圳大学计算机与软件学院、腾讯云、腾讯教育 —— 赛事主办与协办
- 腾讯 LearnBuddy —— 赛事指定开发平台
