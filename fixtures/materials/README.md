# 测试材料库

**一句话**：联调、回归、真实通道实测都从这里取材料 —— **不要再各自现编文本**。

## 怎么用

**① 加载器（推荐，脚本用）**

```js
import { listMaterials, loadMaterialText, loadMaterial, loadAll }
  from '../../fixtures/materials/load.mjs';

loadMaterialText('basic');   // 单份正文（string）
loadMaterial('basic');       // 清单字段 + 正文
loadAll();                   // 全部（含正文）
listMaterials();             // 只有清单
```

**② 手工联调（贴进输入框）**
直接打开对应 `.md` 文件，复制正文贴进「材料」面板即可 —— 材料本来就是给学生贴文本用的。

**③ 打接口**

```bash
# 先起服务端（MODEL_PROVIDER=mock PORT=3000）
curl -sS -X POST http://127.0.0.1:3000/api/session
curl -sS -X POST http://127.0.0.1:3000/api/knowledge \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<上一步的 id>","materials":[{"id":"m1","kind":"upload","text":"<材料正文>","createdAt":"2026-09-23T00:00:00.000Z"}]}'
```

## 清单（10 份）

| id | 文件 | 场景 | 预期（**针对真实模型通道**） |
|---|---|---|---|
| `basic` | `01-basic-derivative.md` | 最常规的讲义：导数定义、几何意义、单调性判据 | 抽出多个知识点并形成关系边 |
| `prerequisite-gap` | `02-monotonicity-only.md` | **只有结论、缺前置**：给了用法但不解释导数是什么 | 「导数」被标为前置缺口（MISSING）→ 测一键补充与状态流转 |
| `formula-heavy` | `03-tangent-and-extrema.md` | 公式密集：切线方程与极值 | 公式识别为 LaTeX；测符号验证四类断言 |
| `out-of-scope` | `04-out-of-scope.md` | 线性代数，与微积分无关 | 走 out-of-scope，**不得**硬抽微积分知识点充数 |
| `too-long` | `05-long.md` | 超单次上限（**加载时重复 6 次** → >3000 字） | 触发上限提示与「开始新学习」引导 |
| `tiny` | `06-tiny.md` | 极短：一句话 | 不崩；给出可读提示（条件不足） |
| `mixed-language` | `07-mixed-language.md` | 中英混排 | 正常抽取；中英术语不被当成两个知识点 |
| `ambiguous` | `08-ambiguous.md` | 表述含糊（"变化快慢"、"……吧"） | 倾向 PENDING，不硬判为已覆盖 |
| `with-exercises` | `09-with-exercises.md` | 讲义 + 两道练习题 | 测练习路径（`source=material`）与画像事件 |
| `plain-narrative` | `10-plain-narrative.md` | 纯叙述、**一个公式都没有** | 公式为**空数组**（≠「通道未接入」）—— 对照图片路径的同口径 |

## 三条注意

1. **`expect` 一栏是给真实模型通道写的。** `MODEL_PROVIDER=mock` 返回的是**固定演示数据**，
   所以 mock 下多数预期不成立 —— mock 只能验证"链路通不通"，验证不了"抽得准不准"。
2. **`05-long.md` 的 `repeat` 是加载时的重复次数**（文件本体很短）：
   这样不必把几千字写进仓库，就能测单次上限（`MATERIAL_LIMITS.maxSingleInputLength` = 3000 字）。
3. **材料只含虚构的教学内容**，不含任何真实学生信息（`scripts/check-sensitive.mjs` 会扫这个目录）。
