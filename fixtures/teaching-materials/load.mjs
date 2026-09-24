/**
 * `P-B15` 教学素材的统一加载器（2026-09-23）。
 *
 * 与 `fixtures/materials/load.mjs` 的分工：
 * - 那一套是**联调用的边界材料**（超长、纯公式、含糊、超范围……），测的是"输入不对怎么办"；
 * - 这一套是**演示与教学用的成稿素材**（3 主题 × 3 形态），测的是"正常用起来是什么样"。
 *
 * 两套都做成"清单 + 加载器"，理由相同：素材要给人看（贴进输入框、肉眼比对），
 * 独立成 `.md` / `.png` 才能被编辑器和预览直接打开。
 *
 * 用法（Node 18+ / ESM）：
 *   import { listMaterials, orthogonality, loadBody, loadImageBase64 } from '.../teaching-materials/load.mjs';
 *   loadBody('monotonicity-text');      // 材料正文（string）
 *   loadImageBase64('monotonicity-image'); // 图片的原始 base64（可直接喂 /api/parse）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 读清单。每次重读，避免"改了 json 但进程还是旧值"的困惑 */
export function listMaterials() {
  return JSON.parse(readFileSync(join(HERE, 'index.json'), 'utf8'));
}

/** 按 id 取一份素材的清单条目 */
export function findMaterial(id) {
  const entry = listMaterials().materials.find((item) => item.id === id);
  if (!entry) {
    const ids = listMaterials().materials.map((m) => m.id).join(' / ');
    throw new Error(`没有这份素材：${id}。可选：${ids}`);
  }
  return entry;
}

/**
 * 取素材的**可读正文**。
 *
 * 形态不同，取法不同，且**都不假装**：
 * - `text` / `voice`：返回 `.md` 正文。语音那份返回的是**转写文本**，
 *   仓库里没有音频（看 `entry.audio.stored === false`）—— 返回字符串就是全部真相。
 * - `image`：**没有文本正文**，返回 `null`。刻意不返回"图里画了什么"的描述 ——
 *   把描述当正文，等于用一段文字冒充一张图，正是 `P-B15` 要避免的造假。
 *   要用图，走 `loadImageBuffer` / `loadImageBase64`。
 */
export function loadBody(id) {
  const entry = findMaterial(id);
  if (entry.form === 'image') return null;
  return readFileSync(join(HERE, entry.file), 'utf8').trim();
}

/** 取图片素材的原始字节（非图片素材抛错，不返回空 Buffer 蒙混过去） */
export function loadImageBuffer(id) {
  const entry = findMaterial(id);
  if (entry.form !== 'image') throw new Error(`${id} 不是图片素材（form=${entry.form}）`);
  return readFileSync(join(HERE, entry.file));
}

/** 取图片素材的 base64（不含 data URI 前缀，可直接放进 /api/parse 的 imageBase64） */
export function loadImageBase64(id) {
  return loadImageBuffer(id).toString('base64');
}

/** 全部素材（含正文；图片素材的 `body` 为 null、`image` 为字节） */
export function loadAll() {
  return listMaterials().materials.map((entry) => ({
    ...entry,
    body: entry.form === 'image' ? null : loadBody(entry.id),
    image: entry.form === 'image' ? loadImageBuffer(entry.id) : null,
  }));
}

/**
 * 列出"主题 × 形态"的覆盖情况，**缺哪格就如实报缺哪格**。
 *
 * 验收判据是"3 主题 × 文字/图片/语音"，所以这个函数的作用就是让 `verify:flow`
 * 能断言**九格一格不缺** —— 而不是靠人数一遍表格说"齐了"。
 * `missing` 为空数组即九宫格填满。
 */
export function orthogonality() {
  const { topics, forms, materials } = listMaterials();
  const present = new Set(materials.map((item) => `${item.topic}/${item.form}`));
  const missing = [];
  for (const topic of topics) {
    for (const form of forms) {
      if (!present.has(`${topic.id}/${form}`)) missing.push(`${topic.id}/${form}`);
    }
  }
  return { topics: topics.map((t) => t.id), forms, cells: [...present].sort(), missing };
}

/** 保留了前置缺口的素材（`prerequisiteGap` 非空）—— 演示路径依赖这几份 */
export function materialsWithGap() {
  return listMaterials().materials.filter((item) => item.prerequisiteGap);
}
