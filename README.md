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
| **轻量知识依赖** | 只建模"学习当前知识点前需要了解什么"，不做复杂图谱。**六态**：`LOCAL` 材料已覆盖 / `SUPPLEMENTED` 已由 AI 补充 / `MISSING` 材料未覆盖 / `PENDING` 待确认 / `VERIFIED` 已验证 / `DISPUTED` 有争议 |
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

单仓库、单 Web 服务。**不引入图数据库**，初赛的图谱为内存图 + JSON 持久化；
向量库按说明书 V2.0 §5.1 的口径**不强制不用**，初赛实现仍以轻量索引为主（未引入嵌入模型）。

### 接口契约

**V2.0 共 10 个接口。** 唯一事实来源是 `packages/contracts/src/*.ts`，下表为速查。
标记：✅ 已实现可用 ｜ ⛔ 未实现（如实返回，不用空数据冒充）。

| 接口 | 用途 | 状态 |
|---|---|---|
| `POST /api/session` | 创建会话，返回初始材料版本 0 与空图谱 | ✅ |
| `GET /api/health` | 版本、当前模型通道、是否 mock、验证引擎状态、**运行形态自证**（`mode`/`entry`/`builtAt`） | ✅ |
| `POST /api/parse` | 文字 / 图片 / 语音 → 识别文本、公式 LaTeX、低置信度标记、`unavailable[]` | ✅（**目前仅纯文字**，其余通道如实列入 `unavailable`） |
| `POST /api/knowledge` | 材料 → 知识点、前置关系与来源；**材料与图谱同一次原子提交并落盘** | ✅ |
| `POST /api/tutor` | 提问 → 分块回答、来源、验证状态、下一步（`sessionId: null` 即零材料轻路径） | ✅ |
| `POST /api/gap` | 缺口概念 → 最小必要补充内容、补充块 ID、更新后的依赖状态 | ✅（**停在 `SUPPLEMENTED`**，转 `VERIFIED` 待符号验证落地） |
| `POST /api/quiz` | 固定题，或基于当前材料生成题 | ✅（**V2.0 由 `GET` 改为 `POST`**） |
| `POST /api/profile` | 画像事件 → 会话内聚合的学习者画像 | ✅ |
| `GET /api/graph` | 图谱邻域（**只做一层，不做多跳**） | ✅（**目前只有节点**，关系边待上游返回） |
| `GET /api/teacher` | 班级聚合 | ⛔ **返回 501**（阶段三，界面亦不渲染该面板） |

错误响应统一经 `apps/server/src/http/error-response.ts` 唯一出口，
状态码与 `retryable` 由一张表按错误码推导，不在各分支写死。

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

### 提交 / 部署前必跑

```bash
npm run verify:predeploy
```

一条命令覆盖三类"最容易被漏掉"的检查 —— `build:clean`（把旧产物**挪走**而非删除）→
`build` → `verify:dist`（**「构建成功」≠「可运行」**，这条踩过坑）→
`verify:repo`（敏感信息、依赖与许可证声明、提示词快照一致性）。
**不要靠人记得**：部署前与提交前都跑它。

也可单独跑其中一段：

```bash
npm run build:clean        # 构建前置清理（在某些沙箱环境里，删除 dist 会被安全策略拦住）
npm run verify:sensitive   # 工作区 + 待提交文件 + 全部历史 blob 的密钥/PII 扫描
npm run verify:licenses    # 依赖声明 ↔ 安装 ↔ README 表 双向核对 + 许可证 + 脚本命令提供方
npm run verify:prompts     # 提示词快照与 packages/teaching/src/prompt.ts 逐字比对
```

### 模型通道

| `MODEL_PROVIDER` | 通道 | 说明 |
|---|---|---|
| `deepseek`（**默认**） | DeepSeek API | HTTP 适配器，OpenAI 兼容格式。依据说明书 V2.0 |
| `sdk` | CodeBuddy Agent SDK | **历史接入**，须显式启用，不参与自动降级 |
| `mock` | 假数据 | 仅供本地开发；**界面上有醒目横幅与逐条标记**，不会被误当成真实模型输出 |

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
  README.md       目录导览、命名规范、路径变更映射、断点登记
  知识库.md        所有长期有效的约定：架构、接口契约、状态机、常量配置、错误码、协作纪律、环境限制
  todo.md         待办总表：阻断项 / 缺陷 / 计划 / 待确认
  specs/          ★ 规格与约束正本
                    微积分学伴_项目说明书.md       工作正本（当前 V2.0）
                    微积分学伴_初赛补充说明.md     初赛形态/部署/验收口径（补充文件，不替换正本）
                    大湾区AI_Coding创新大赛_赛事手册.md
                    赛题意图与产品设计分析.md
  plans/          每轮开发计划
  changelogs/     每轮变更记录
  reviews/        每轮评审记录（含对 AI 输出的否决与修改）
  tech/           技术决策记录
  designs/        设计稿与方案母本（说明书的上游输入）
  archive/        原始交付件留档（.docx 等）
```

> **docs 根目录只有三个导航文件**（`README.md` / `知识库.md` / `todo.md`）。
> 2026-09-17 把**三份**正本从 `docs/` 根**移入** `docs/specs/`（另有 `初赛补充说明.md`
> 同日**直接新建**于 `specs/`，从未在根目录存在过）；历史文档中的旧路径引用
> **一律不改写**，换算表见 [`docs/README.md`](./docs/README.md) §三。

## 开发文档留痕

本项目采用四类开发文档记录开发过程，与 LearnBuddy 对话记录互相溯源，命名 `YYYY-MM-DD-<主题>.md`：

- `docs/plans/` — 每轮开始前：目标、任务分解、验收条件
- `docs/changelogs/` — 每轮结束后：改了什么、为什么、影响模块、验收结论
- `docs/reviews/` — 每轮结束后：AI 输出核对结果，**必须包含被否决或被修改的记录**
- `docs/tech/` — 重大决策：选型、契约变更、取舍理由、已知限制

另有 `docs/designs/`（设计稿与方案母本）与 `docs/archive/`（原始交付件留档）。
**动手前先看 [`docs/知识库.md`](./docs/知识库.md)，认领任务看 [`docs/todo.md`](./docs/todo.md)。**
完整导览与已知断点登记见 [`docs/README.md`](./docs/README.md)。

## 团队分工

| 成员 | 负责 |
|---|---|
| A | 前端交互 `apps/web` |
| B | 教学智能 `packages/teaching` |
| C | 服务、契约与部署 `apps/server`、`packages/contracts` |

## 当前状态

> 口径：**以代码与回归脚本为准，不以设计文档为准**。下面每一句都对应可运行的实现或有断言的脚本。
> 更新时间 2026-09-18（**合并 PR #8 / #9 后同步**；上一版为缺陷修复 I13–I20）。

**核心材料路径可交互运行。** 说明书已更新至 **V2.0**；契约迁移 V2.0 已落地。
**前后端同源部署**（`P-C13`）：同一个地址既提供页面也提供 `/api`。
回归脚本 **387 项全部通过**：`verify:all` **190**（`store` 22 / `errors` 34 / `guards` 81 / `graph` 53）、
`verify:flow` **36**（真实 HTTP）、`verify:dist` **11**（构建产物形态，含**运行形态自证**）、
`verify:render` **88**（前端渲染冒烟）、`verify:serve-web` **28**（同源托管：SPA 回退的**边界**、
编码/超长扩展名/结尾斜杠三种绕过、产物消失时 404 而非 500、自动探测）、
`verify:repo` **34**（敏感信息 / 依赖与许可证 / 提示词快照）。
全部为离线或 mock 通道，**不消耗模型额度**。

### 已实现（可演示）

- **契约层 10 个接口，9 个可用**（`GET /api/teacher` 如实返回 501，见下）
- **材料路径工作台**：材料卡片、**依赖六态**、缺口一键盘补、可展开的「依据详情」、练习、画像六个面板
- **图谱落盘**：`POST /api/knowledge` 把材料与图谱做**同一次原子提交**，`GET /api/graph` 可读一层邻域
- **会话内画像**：`POST /api/profile` 按事件聚合，补充内容**不跨会话迁移**
- **mock 与真实两条入口在界面上一眼可分**：mock 时页头有醒目横幅、**每条答疑回答带 `mock 演示数据` 标记**；
  真实通道下这些标记不出现（有断言锁住）
- **错误态可自愈**：`retryable` 为真时给出可用的重试按钮，失败保留输入，过期会话响应被丢弃

### 未实现（**不得视为可用**）

| 能力 | 现状 | 编号 |
|---|---|---|
| **符号验证**（P0） | 引擎选型已定（纯 TS / `mathjs`），**代码未开始**；`/api/gap` 因此只能停在 `SUPPLEMENTED`，`/api/health` 的 `verification.available` 为 `false` | `B3` |
| **图谱关系边** | 存储层已就绪，但上游模型不返回 `edges` → 图谱**只有节点**；**界面不凭空连线** | `I1` |
| **多模态解析** | `/api/parse` **目前仅支持纯文字**。**只有图片／只有语音** → `400 BAD_REQUEST` 说明该通道未接入；**文字＋图片** → 200 且把 `image`、`formula` 如实列入 `unavailable[]`。语音入口已就位但明确标注未接入 | `I6` |
| **在线链接 / 部署** | **尚未部署**（四件套中唯一未完成的一件），但**已无未知项**：载体已定（腾讯云 CloudBase 云托管，`D4` 2026-09-18 拍板），**同源托管本地已实现并验证**（`P-C13`，专项 `verify:serve-web` 28 项），只剩在控制台执行。⚠️ 用默认域名打开会先出现一次「访问提示中间页」，点「确定访问」后进入 | `P-C14` |
| **教师视图 · 多智能体 · 错题归因** | 仅设计（P1），见 `docs/plans/2026-09-17-第6轮-V2.0全量对齐.md` §6；教师视图界面**不渲染空面板** | `I7` `P-A6` |
| **语音输入** | **入口已就位，识别通道未接入**（与上一行的"仅设计"不同）—— 入口明确说明不可用，不假装可识别 | `P-A7` `I6` |

### 已知限制

- **无法做浏览器视觉验证**：本环境不可安装 `agent-browser`，只能以 `verify:render`（88 项）做渲染冒烟，
  **它不替代人眼验收**；提交前需人工按 `docs/specs/微积分学伴_界面验收清单.md` 实点一遍。
- **真实模型路径尚未在本轮回归中跑过**：DeepSeek 通道此前已用真实密钥验收（文字 1213 ms、图片 3195 ms），
  但当前回归与演示均走 `MODEL_PROVIDER=mock`。

**模型适配层已完成，两个真实通道均通过真实密钥验收**（文字与图片调用都实测通过）：

- **默认通道 DeepSeek**：文字 1213 毫秒、图片 3195 毫秒（同轮实测，明细见
  `docs/changelogs/2026-09-17-C-DS转为默认通道.md`）
- 历史接入 CodeBuddy Agent SDK：文字 12–21 秒、图片 17.7 秒（正是说明书改以 DS 为默认的原因）

通道由 `MODEL_PROVIDER` 控制，默认 `deepseek`。**没有自动降级**：缺密钥或模型失败时明确报错，
配置不完整时服务拒绝启动并打印缺失项 —— 不静默切换通道。

错误响应统一经 `apps/server/src/http/error-response.ts` 出口：状态码与 `retryable` 由
**唯一一张表**按错误码推导，不在各分支里写死 —— 同一个契约错误码在入口校验与提交复核
两条路径上给出完全相同的状态码与是否可重试。

**本仓库中标为"设计""后续迭代"或上表"未实现"的能力，请勿视为已完成功能。**
反过来，**已实现的能力也不会被低报**：若本文与代码不一致，以代码与回归脚本为准，并视为本文的缺陷。

## 第三方依赖声明

按赛事手册 8.2 要求注明所使用的开源框架与第三方库。下表与各 workspace 的 `package.json`
**逐条双向核对**，核对脚本为 `npm run verify:licenses`（同时校验许可证声明与安装版本一致、
以及 npm 脚本用到的命令都有已声明的依赖提供）。

| 依赖 | 版本 | 用途 | 许可 |
|---|---|---|---|
| `@tencent-ai/agent-sdk` | ^0.3.259 | 模型推理调用（CodeBuddy Agent SDK，历史接入通道） | MIT |
| `express` | ^4.21.0 | HTTP 服务（`apps/server`） | MIT |
| `dotenv` | ^16.4.0 | 服务端环境变量加载 | BSD-2-Clause |
| `react` / `react-dom` | ^19.0.0 | 前端框架（`apps/web`） | MIT |
| `vite` | ^6.0.0 | 前端构建与开发服务器 | MIT |
| `@vitejs/plugin-react` | ^4.3.4 | Vite 的 React 插件 | MIT |
| `concurrently` | ^10.0.5 | 根 `npm run dev` 同时启动前后端 | MIT |
| `tsx` | ^4.19.0 | 开发期 TypeScript 运行器 | MIT |
| `tsup` | ^8.3.0 | 服务端构建 | MIT |
| `typescript` | ^5.7.0 | 构建与类型检查 | Apache-2.0 |
| `@types/express` | ^5.0.0 | Express 类型定义 | MIT |
| `@types/node` | ^22.10.0 | Node 类型定义 | MIT |
| `@types/react` / `@types/react-dom` | ^19.0.0 | React 类型定义 | MIT |
| `mathjs` | ^15.2.0（**计划引入**） | 符号验证引擎（求导、化简、求值） | Apache-2.0 |

> `mathjs` 尚未安装：选型已定（见 `docs/tech/2026-09-17-符号验证引擎选型-纯TS.md`），
> 由 B 在实现 `packages/teaching/src/symbolic.ts` 时一并声明。

> ⚠️ **本轮修正**：`concurrently` 此前被根 `npm run dev` 使用却**从未声明** ——
> 本机装了能跑，**别人 clone 下来 `npm run dev` 会直接失败**（违反补充说明 §5.2「他人可照着跑起来」）。
> 已补进根 `devDependencies`。`@types/*` 与 `@vitejs/plugin-react` 此前也未在表中声明，一并补齐。
> 这两类问题现在由 `verify:licenses` 自动拦截。

第三方推理接口的使用方式以赛事方最终答复为准（见 `docs/tech` 模型接入记录的待办项）。

## 开源协议

本项目采用 [MIT License](./LICENSE)。

## 致谢

- 深圳大学计算机与软件学院、腾讯云、腾讯教育 —— 赛事主办与协办
- 腾讯 LearnBuddy —— 赛事指定开发平台
