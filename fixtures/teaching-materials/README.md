# 教学素材（`P-B15`）

**一句话**：3 主题 × 3 形态，共 **9 份** —— 演示与录屏从**这里**取素材，不要再临时编。

## 与 `fixtures/materials/` 的分工

| 目录 | 是什么 | 测什么 |
|---|---|---|
| `fixtures/materials/`（10 份） | **联调用的边界材料**：超长、纯公式、含糊、超范围、中英混排…… | 输入不对时会怎样 |
| `fixtures/teaching-materials/`（9 份，本目录） | **教学成稿素材**：导数 / 切线 / 单调性 各一份文字、图片、语音 | 正常用起来是什么样 |

两边都做成了"清单 `index.json` + 加载器 `load.mjs`"，理由相同：素材是**给人看**的，
独立成文件才能被编辑器直接打开（贴进输入框、肉眼比对）。

## 清单（9 份）

| 主题 | 文字 | 图片 | 语音 |
|---|---|---|---|
| **导数** | `text/01-derivative.md` 定义（极限形式）+ 几何意义 | `images/derivative.png` 割线 PQ 与切线 | `voice/01-derivative.md` 转写 |
| **切线** | `text/02-tangent.md` 切线方程 + 三个例题 | `images/tangent.png` X=-1.5 处的切线 | `voice/02-tangent.md` 转写 |
| **单调性** ⚠️ | `text/03-monotonicity.md` **只给结论，不给导数的定义** | `images/monotonicity.png` **F' 未定义** | `voice/03-monotonicity.md` **只讲用法** |

> ⚠️ **单调性那一列的「不完整」是刻意的**，见下节。

## ⚠️ 单调性素材**必须保留导数前置缺口**

验收原话：**"单调性素材必须保留导数前置缺口（演示案例的前提）"**。
所以三份单调性素材**都只用结论与用法，通篇不给导数的定义** ——
连"导数是一个极限""导数是切线斜率"这类一句话的提示也**不给**：
给了等于把缺口填上，`MISSING` 就不会被标出来，`MISSING → SUPPLEMENTED → VERIFIED`
这条演示路径随之失效。

这条不是靠人记住的，`verify:flow` 会**机械地**验：

- 三份单调性素材的正文里**都不得出现**导数定义的标志词（"极限""瞬时变化率""割线的极限"等）；
- 导数主题的正文里**必须出现**这些标志词（否则"没有缺口"这句话就没有依据）；
- `index.json` 里三份单调性素材的 `prerequisiteGap` 都指向 `derivative`。

图里那条 `F-PRIME NOT DEFINED HERE` 是**刻意印上去的**：让缺口在图上就是可见的事实，
而不是只在文档里写一句、图却看起来自洽。

## 图片素材：**程序生成**的真实 PNG

`images/*.png` 是**程序生成的函数示意图**（坐标轴、网格、曲线、切线、关键点），
**不是教材插图**，不含任何外部版权素材 —— 所以可以直接进仓库。

- 生成器：`generate-images.mjs`（`lib/png.mjs` 自带 PNG 编码、`lib/font5x7.mjs` 自带点阵字库，**零依赖**）；
- 重新生成：`node fixtures/teaching-materials/generate-images.mjs`；
- 比对（不改文件）：`node fixtures/teaching-materials/generate-images.mjs --check`。

**输出是逐字节确定的**（不写时间戳、压缩参数写死），所以"仓库里那份"与"现在重新生成的那份"
可以逐字节比对 —— `verify:flow` 就是这么验的。图片因此和代码一样受版本控制与审查，
而不是一份"谁也不知道怎么来的"二进制。

> 图片里的标注**一律 ASCII 大写**（`F(X)=X^2`、`SECANT`）：点阵字库画不了汉字。
> 中文讲解在同目录的 `.md` 与 `index.json` 的 `figure.caption` 里 ——
> 图是示意图，题注才是讲解，这正是教材的常规做法。

## 语音素材：**只有转写文本，没有音频**

`voice/*.md` 是口语讲解的**转写文本**。关于它，三件事必须说清楚：

1. **仓库里没有音频文件，也不会有。** 语音转写由**浏览器**完成（`D3` 已拍板的边界），
   服务端**不做** ASR（`GET /api/health` 的 `capabilities.audio` 如实声明为不可用）。
   把一段音频塞进仓库，既没有对应的服务端能力去处理它，也没有任何校验能证明它"是语音"。
2. **不做假音频。** 用 `ffmpeg` 合成一段正弦波然后叫它"语音素材"，是拿空数据冒充能力 ——
   项目纪律里点名禁止的那件事。
3. **`index.json` 里 `audio.stored` 一律是 `false`。** 这不是缺省值，是**结论**；
   谁要改成 `true`，得先有真实的音频文件和能处理它的通道。

因此语音素材的正确用法是：**把它当文字素材用**（走同一条管道），
或者演示时用界面上的「语音输入」现场边说边转 —— 那条路径是浏览器侧的，与这里无关。

（已实测：`POST /api/parse` 带 `audioBase64` 而不带文字时返回 400，并说明"语音不由服务端转写"。
`verify:flow` 有对应断言。）

## 怎么用

**① 加载器（脚本用）**

```js
import { listMaterials, orthogonality, loadBody, loadImageBase64, materialsWithGap }
  from '../../fixtures/teaching-materials/load.mjs';

loadBody('monotonicity-text');          // 材料正文（string）
loadImageBase64('monotonicity-image');  // 图片 base64，可直接喂 /api/parse
orthogonality().missing;                // 九宫格缺哪格（空数组 = 齐了）
materialsWithGap();                     // 保留前置缺口的那三份
```

**② 手工联调**：直接打开对应 `.md` 复制正文贴进「材料」面板。
图片用界面上的上传（或把 base64 打给 `/api/parse`）。

**③ 打接口**

```bash
# 先起服务端（MODEL_PROVIDER=mock PORT=3000）
curl -sS -X POST http://127.0.0.1:3000/api/session
curl -sS -X POST http://127.0.0.1:3000/api/parse -H 'content-type: application/json' \
  -d "{\"imageBase64\":\"$(node -e "process.stdout.write(require('fs').readFileSync('fixtures/teaching-materials/images/derivative.png').toString('base64'))")\"}"
```

> ⚠️ `loadBody('...-image')` 返回 `null` —— 图片素材**没有文本正文**，
> 刻意不返回"图里画了什么"的描述：把描述当正文，就是用文字冒充图片。

## 三条注意

1. **`expect` 一栏是给真实模型通道写的。** `MODEL_PROVIDER=mock` 返回固定演示数据，
   所以 mock 下多数预期不成立 —— mock 只能验"链路通不通"，验不了"抽得准不准"。
2. **素材里没有真实学生信息**，内容是虚构的课堂笔记（`scripts/check-sensitive.mjs` 会扫这个目录）。
3. **改了素材就要重跑 `verify:flow`**：里面按份数、形态、缺口标记逐条断言，
   少一份或多一份都会红。
