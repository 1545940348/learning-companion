/**
 * 测试材料的统一加载器（2026-09-23）。
 *
 * 用途：让 `verify:flow`、联调脚本与人工测试**用同一份材料**，不再各自现编文本。
 *
 * 为什么做成"清单 + 加载器"而不是一个 JSON 塞满字符串：
 * 材料要**给人看**（联调时贴进输入框、真实通道实测时肉眼比对），
 * 独立成 `.md` 文件才能直接被编辑器/预览打开；`index.json` 只描述"每份是干什么的、预期什么"。
 *
 * 用法（Node 18+ / ESM）：
 *   import { listMaterials, loadMaterialText, loadMaterial } from '../../fixtures/materials/load.mjs';
 *   const text = loadMaterialText('basic');        // 单份
 *   const all = listMaterials();                   // 清单（含 id/title/scenario/expect）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 读清单（每次重读：清单很短，避免"改了 json 但进程还是旧值"的困惑） */
export function listMaterials() {
  return JSON.parse(readFileSync(join(HERE, 'index.json'), 'utf8')).materials;
}

/**
 * 读一份材料的正文。
 *
 * `repeat` 字段表示"加载时重复几次" —— 用于**在不写几千字的前提下**造出超长材料
 * （测单次上限）。重复时用空行分隔，保持"像多页讲义"的观感。
 */
export function loadMaterialText(id) {
  const entry = listMaterials().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`没有这份材料：${id}。可选：${listMaterials().map((m) => m.id).join(' / ')}`);
  }
  const body = readFileSync(join(HERE, entry.file), 'utf8').trim();
  const repeat = Number.isInteger(entry.repeat) && entry.repeat > 1 ? entry.repeat : 1;
  return repeat === 1 ? body : Array.from({ length: repeat }, () => body).join('\n\n');
}

/** 清单 + 正文（供"遍历全部材料跑一遍"的脚本用） */
export function loadMaterial(id) {
  const entry = listMaterials().find((item) => item.id === id);
  if (!entry) throw new Error(`没有这份材料：${id}`);
  return { ...entry, text: loadMaterialText(id) };
}

/** 全部材料（含正文） */
export function loadAll() {
  return listMaterials().map((entry) => loadMaterial(entry.id));
}
