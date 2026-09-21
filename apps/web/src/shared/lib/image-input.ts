/**
 * 图片文件读取与**前端侧**快速校验（视觉入口）。
 *
 * ### 为什么单独成文件
 *
 * 把 `File → base64` 的读盘与校验从面板组件里分出来：组件只负责"什么时候调"，
 * 本模块负责"怎么读、怎么拦"。这样它可被单测，也能被别的入口复用
 * （`shared/` 是最底层，不反向依赖 `components/`）。
 *
 * ### ⚠️ 这里的校验**不是安全边界**
 *
 * 前端校验只为**少一次无效往返**（把明显不合法的情况在当地拦下并给出人话提示）。
 * 真正的判定在服务端 `apps/server/src/parse/vision.ts`：那里按**文件魔数嗅探**
 * 判断真实格式、按字节数判体积，**不信任客户端声明的 MIME**。
 * 两处都做，不是重复劳动 —— 一处是体验，一处是边界。
 *
 * ### 载荷约束（与后端同源）
 *
 * 仅 `image/png` / `image/jpeg`；≤ `MATERIAL_LIMITS.maxImageBytes`（5 MB）；
 * 产出**不含 data URI 前缀**的原始 base64（与契约 `ParseRequest.imageBase64` 一致）。
 */

import { MATERIAL_LIMITS } from '@lc/contracts';

export type AllowedImageMediaType = 'image/png' | 'image/jpeg';

export type ReadImageResult =
  | { ok: true; base64: string; bytes: number; mediaType: AllowedImageMediaType }
  | { ok: false; problem: string };

const ALLOWED_MEDIA_TYPES: readonly AllowedImageMediaType[] = ['image/png', 'image/jpeg'];

function isAllowed(type: string): type is AllowedImageMediaType {
  return (ALLOWED_MEDIA_TYPES as readonly string[]).includes(type);
}

/** 字节 → base64。分块处理：一次性 `String.fromCharCode(...big)` 会爆调用栈 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * 读取并校验一张图片。
 *
 * **不抛异常**：所有失败都变成 `{ ok: false, problem }`，
 * 由调用方决定怎么提示 —— 组件层不需要为"读文件"写 try/catch。
 */
export async function readImageFile(file: File): Promise<ReadImageResult> {
  if (!isAllowed(file.type)) {
    return { ok: false, problem: '只支持 PNG 或 JPEG 图片，请换一张。' };
  }

  const maxBytes = MATERIAL_LIMITS.maxImageBytes;
  if (file.size > maxBytes) {
    return {
      ok: false,
      problem:
        `图片 ${(file.size / 1024 / 1024).toFixed(1)} MB 超过上限 ` +
        `${Math.round(maxBytes / 1024 / 1024)} MB，请压缩后重试。`,
    };
  }
  if (file.size === 0) {
    return { ok: false, problem: '这个文件是空的，请重新选择。' };
  }

  try {
    const buffer = await file.arrayBuffer();
    return {
      ok: true,
      base64: bytesToBase64(new Uint8Array(buffer)),
      bytes: file.size,
      mediaType: file.type,
    };
  } catch {
    // 读盘失败的原因（文件被移走 / 权限 / 磁盘）对学生没有意义，给可操作的一句话
    return { ok: false, problem: '读取图片失败，请重新选择文件。' };
  }
}
