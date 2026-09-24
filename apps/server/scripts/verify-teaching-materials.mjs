/**
 * 教学素材（`P-B15`）验证脚本 —— 2026-09-23，B 负责
 *
 * ### 这个脚本要证明的两件事
 *
 * 1. **3 主题 × 文字/图片/语音 九格填满**（验收原文），而且是**清单算出来的**，
 *    不是人数了一遍表格说"齐了"；
 * 2. **单调性素材确实保留了导数前置缺口**（验收原文括注）——
 *    三份单调性素材通篇搜不到导数的定义标志词。
 *
 * ### 为什么第 2 条要用"搜标志词"这种笨办法
 *
 * "缺口保留住了"是一句**很容易自我感觉良好**的话：写素材的人在末尾顺手加一句
 * "导数就是切线斜率"，读起来是体贴，实际上把缺口填上了 —— `MISSING` 不再被标出，
 * `MISSING → SUPPLEMENTED → VERIFIED` 这条演示路径直接失效，而**所有测试照绿**。
 * 所以这里把它压成一条硬检查：单调性素材里出现定义标志词就红。
 * 同时反向证明标志词**不是空集**（导数主题的素材合起来必须用全这些词），
 * 否则"谁都不含"也能通过，那是条假断言。
 *
 * ### 为什么和 `verify:flow` 分家
 *
 * 这里全是**文件系统**的事（清单、正文、PNG 字节、字库覆盖），不需要服务端。
 * 放在 `verify:all`（离线、每次改动都会跑）里，才能保证"缺口还在"这件事
 * 不依赖"有没有人刚起了一个服务端"。`verify:flow` 那边只留**过线**的部分
 * （图片真的被 `/api/parse` 接受、坏签名真的被拒、只带语音真的报 400）——
 * 两边不重复断言同一件事，避免改一处忘一处。
 *
 * 用法（在 apps/server 目录下）：
 *   npm run verify:teaching-materials
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listMaterials,
  loadBody,
  loadImageBuffer,
  materialsWithGap,
  orthogonality,
} from '../../../fixtures/teaching-materials/load.mjs';
import { FIGURES, buildImage, checkGlyphs } from '../../../fixtures/teaching-materials/generate-images.mjs';
import { HEIGHT, WIDTH } from '../../../fixtures/teaching-materials/lib/canvas-kit.mjs';
import { readPngSize } from '../../../fixtures/teaching-materials/lib/png.mjs';

/*
 * 必须用**相对本文件**解析出来的绝对路径：脚本的工作目录是 `apps/server`，
 * 写 `'fixtures/teaching-materials'` 会解析成 `apps/server/fixtures/...` 而找不到。
 */
const MATERIALS_DIR = fileURLToPath(new URL('../../../fixtures/teaching-materials/', import.meta.url));

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failed += 1;
    console.log(`  [失败] ${label}${detail === undefined ? '' : ` —— ${JSON.stringify(detail)}`}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/*
 * 定义标志词取的是"只有讲导数的定义时才会出现"的那些说法。
 * 用一组词而不是一个：单看"极限"会漏掉换个说法讲定义的情况。
 * 这组词是**从导数素材正文里反推出来的**，下面有一条断言证明它们真的会出现 ——
 * 检查必须有牙，不能是一条永远为真的断言。
 */
const DERIVATIVE_DEFINITION_MARKERS = ['极限', '瞬时变化率', '平均变化率', '割线', '无限接近'];

const manifest = listMaterials();
const materials = manifest.materials;

console.log('=== 教学素材：3 主题 × 3 形态，且单调性**保留**导数前置缺口（P-B15） ===');

/* ---------- 1. 清单自身的形状 ---------- */

section('1. 清单：9 份、id 自洽、字段齐');

check('★ 清单可读，正好 9 份', materials.length === 9, materials.length);
check(
  '★ id 不重复（重复会让"按 id 取"取到另一份）',
  new Set(materials.map((m) => m.id)).size === materials.length,
);
check(
  '★ id 形如 `<topic>-<form>`，与 topic / form 字段自洽（三处说法必须一致）',
  materials.every((m) => m.id === `${m.topic}-${m.form}`),
  materials.filter((m) => m.id !== `${m.topic}-${m.form}`).map((m) => m.id),
);
check(
  '★ 每份都有 topic / form / file / scenario / expect（缺一个就不算成稿素材）',
  materials.every((m) => m.topic && m.form && m.file && m.scenario && m.expect),
);
check(
  '★ topic 与 form 的取值都在清单声明的集合里（凭空多一个主题 = 正交性被破坏）',
  materials.every(
    (m) => manifest.topics.some((t) => t.id === m.topic) && manifest.forms.includes(m.form),
  ),
);

/* ---------- 2. 九宫格 ---------- */

section('2. 3 主题 × 3 形态：九格填满（算出来的，不是数出来的）');

const ortho = orthogonality();
check('★ 主题正好 3 个、形态正好 3 个', ortho.topics.length === 3 && ortho.forms.length === 3, {
  topics: ortho.topics,
  forms: ortho.forms,
});
check(
  '★★ 九格**一格不缺**（`missing` 为空且实际格子数为 9）',
  ortho.missing.length === 0 && ortho.cells.length === 9,
  { cells: ortho.cells.length, missing: ortho.missing },
);

/* ---------- 3. 文件真的在那儿、真的有内容 ---------- */

section('3. 文件：都在、都有实质内容、图片不冒充文本');

check(
  '★ 每份 file 真的存在且非空（清单写着有、磁盘上没有 = 断链）',
  materials.every((m) => {
    const path = join(MATERIALS_DIR, m.file);
    return existsSync(path) && readFileSync(path).length > 0;
  }),
  materials.filter((m) => !existsSync(join(MATERIALS_DIR, m.file))).map((m) => m.file),
);

const imageEntries = materials.filter((m) => m.form === 'image');
check('★ 图片素材正好 3 份', imageEntries.length === 3, imageEntries.length);
check(
  '★★ `loadBody` 对图片素材返回 null —— **不拿"图的描述"冒充正文**',
  imageEntries.every((m) => loadBody(m.id) === null),
  imageEntries.map((m) => `${m.id}:${loadBody(m.id)}`),
);

const readable = materials.filter((m) => m.form !== 'image').map((m) => ({ entry: m, body: loadBody(m.id) }));
check(
  '★ 文字/语音素材正文都有实质内容（≥200 字，不是占位文本）',
  readable.every((item) => item.body.length >= 200),
  readable.map((item) => `${item.entry.id}:${item.body.length}`).join(' '),
);

/* ---------- 4. 图片：真 PNG、尺寸对、与源码逐字节相同 ---------- */

section('4. 图片：真 PNG、尺寸与清单一致、与**现在重新生成**的结果逐字节相同');

const pngs = imageEntries.map((entry) => {
  const onDisk = loadImageBuffer(entry.id);
  const size = readPngSize(onDisk);
  return {
    id: entry.id,
    size,
    isPng: size !== null,
    sizeMatchesManifest: size?.width === entry.figure.width && size?.height === entry.figure.height,
    sizeMatchesCanvas: size?.width === WIDTH && size?.height === HEIGHT,
    matchesSource: onDisk.equals(buildImage(entry.figure.figureId)),
  };
});

check(
  '★★ 三张图都是**真 PNG**（签名 + IHDR 解析得出来，不是改过扩展名的别的东西）',
  pngs.every((p) => p.isPng),
  pngs.map((p) => `${p.id}:${p.isPng}`).join(' '),
);
check(
  '★ 尺寸与清单声明一致，且等于画布尺寸 640×440（三处说法一致）',
  pngs.every((p) => p.sizeMatchesManifest && p.sizeMatchesCanvas),
  pngs.map((p) => `${p.id}:${p.size?.width}×${p.size?.height}`).join(' '),
);
check(
  '★★ 仓库里那份与**现在重新生成**的结果逐字节相同（图片受版本控制，不是来路不明的二进制）',
  pngs.every((p) => p.matchesSource),
  pngs.filter((p) => !p.matchesSource).map((p) => p.id).join(',') || '全部一致',
);
check(
  '★ 图片里用到的 ASCII 标注字，字库都画得出来（画不出的会变成方框，只有人凑近才发现）',
  checkGlyphs().length === 0,
  checkGlyphs().join(' / '),
);
check(
  '★ 清单里的 figure 字段与画法表的 id 一一对得上（写错了会拿错图去比字节）',
  pngs.length === 3 && FIGURES.every((f) => imageEntries.some((e) => e.figure.figureId === f.id)),
);

/* ---------- 5. 缺口：单调性素材**确实没有**给导数的定义 ---------- */

section('5. 导数前置缺口：单调性素材**搜不到**导数的定义（这是验收判据）');

const gapReadable = readable.filter((item) => item.entry.topic === 'monotonicity');
check('★ 单调性有文字与语音两份可读正文（图片那份无正文，见第 3 节）', gapReadable.length === 2, gapReadable.length);
check(
  '★★ 单调性素材**一个定义标志词都搜不到**（搜得到 = 缺口被填上，MISSING 不会再被标出）',
  gapReadable.every((item) => DERIVATIVE_DEFINITION_MARKERS.every((word) => !item.body.includes(word))),
  gapReadable
    .map((item) => `${item.entry.id}:${DERIVATIVE_DEFINITION_MARKERS.filter((w) => item.body.includes(w)).join('|') || '干净'}`)
    .join(' '),
);

/*
 * 反向证明：标志词不是空集。
 * 注意要求是"导数主题的素材**合起来**用到了全部标志词"，而不是"每一份都用到"——
 * 语音那份是口语转写，讲的就是割线转切线，但不会说出"瞬时变化率"这种书面词。
 * 要求每一份都含全部标志词，等于用书面语的用词习惯去卡口语转写，那是假要求。
 */
const derivativeReadable = readable.filter((item) => item.entry.topic === 'derivative');
check(
  '★★ 导数主题的素材**合起来**用到了全部标志词（否则上一条是空跑：谁都不含也算通过）',
  DERIVATIVE_DEFINITION_MARKERS.every((word) => derivativeReadable.some((item) => item.body.includes(word))),
  DERIVATIVE_DEFINITION_MARKERS.filter((w) => !derivativeReadable.some((i) => i.body.includes(w))).join('|') ||
    '全部命中',
);

const gapMaterials = materialsWithGap();
check(
  '★★ 标了 `prerequisiteGap` 的**正好是**三份单调性素材，且都指向 derivative',
  gapMaterials.length === 3 &&
    gapMaterials.every((m) => m.topic === 'monotonicity' && m.prerequisiteGap === 'derivative'),
  gapMaterials.map((m) => `${m.id}→${m.prerequisiteGap}`),
);
check(
  '★ 清单里 monotonicity 主题自身也标了缺口（与素材级标记同源，不会一处一处漂）',
  manifest.topics.find((t) => t.id === 'monotonicity')?.prerequisiteGap === 'derivative',
);
check(
  '★ 导数主题**没有**标缺口（它正是要补上的那一份；标了就成了"缺口永远补不上"）',
  manifest.topics.find((t) => t.id === 'derivative')?.prerequisiteGap === null,
);

/*
 * 切线素材的 `prerequisiteGap` 是 null，但它**同样不给导数的定义** ——
 * 这个区别必须写出来，否则读者会把 null 读成"这一份自足"，那是个假印象。
 */
check(
  '★ 切线素材三份都标了 caveat，写明"不给导数的定义"（`null` ≠ 自足）',
  materials.filter((m) => m.topic === 'tangent').every((m) => Boolean(m.caveat)) &&
    manifest.topics.find((t) => t.id === 'tangent')?.caveat,
);

/* ---------- 6. 语音：只有转写文本，没有音频 ---------- */

section('6. 语音素材：如实标注"仓库里没有音频"');

const voiceEntries = materials.filter((m) => m.form === 'voice');
check('★ 语音素材正好 3 份', voiceEntries.length === 3, voiceEntries.length);
check(
  '★★ 三份都如实标着 `audio.stored === false` 且 `serverSideTranscription === false`',
  voiceEntries.every((m) => m.audio?.stored === false && m.audio?.serverSideTranscription === false),
  voiceEntries.map((m) => `${m.id}:${m.audio?.stored}`),
);
check(
  '★ 标注里写明了"识别在浏览器侧"（与 D3 的边界一致，不是"以后再做"的含糊说法）',
  voiceEntries.every((m) => m.audio?.transcribedBy === 'browser'),
);

const audioFiles = readdirSync(MATERIALS_DIR, { recursive: true }).filter((name) =>
  /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(String(name)),
);
check(
  '★★ 素材目录里**一个音频文件都没有**（有的话就与 `stored: false` 自相矛盾）',
  audioFiles.length === 0,
  audioFiles.join(' '),
);

/* ---------- 结果 ---------- */

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
