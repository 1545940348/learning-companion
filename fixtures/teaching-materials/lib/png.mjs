/**
 * 极简 PNG 编码器 + 画布（`P-B15` 教学素材的图片生成用，2026-09-23）。
 *
 * ### 为什么不引依赖
 *
 * `P-B15` 只画三张函数图像。为一个纯装饰性需求引入 `canvas`（原生编译）
 * 或 `sharp`（原生 + 平台二进制）会让 `npm ci` 多一层失败面 —— 而 `I39`
 * （锁文件缺全平台可选依赖）说明这个项目**已经在为依赖付出代价了**。
 * PNG 的格式足够简单：签名 + 三个块（IHDR / IDAT / IEND），
 * 压缩用 Node 自带的 `zlib`，CRC32 自带实现。本文件因此**零依赖**。
 *
 * ### 只实现"真彩色、无隔行、无 alpha"
 *
 * 色彩类型 2（RGB，每像素 3 字节）、位深 8、隔行 0。教学示意图不需要透明，
 * 也不需要调色板。**只实现用得上的**，把没实现的说清楚（见 `toPng` 的注释），
 * 不留给后来人一个"看起来什么都能存"的假 API。
 *
 * ### 输出必须**逐字节确定**
 *
 * 生成脚本不写 `tIME` 块（时间戳会让同一张图每次字节都不同），
 * 并且压缩参数写死。于是"重新生成一遍"与"仓库里那份"可以**逐字节比对** ——
 * `verify:flow` 就是这么验的：图片不是随手贴进来的二进制，源码里生成得出来。
 */

import { deflateSync } from 'node:zlib';
import { GLYPH_GAP, GLYPH_HEIGHT, GLYPH_WIDTH, glyphFor } from './font5x7.mjs';

/** PNG 文件签名（`vision.ts` 的魔数嗅探认的就是这 8 个字节） */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32（PNG 每个块尾部都要）。查表法，标准多项式 0xEDB88320 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 颜色一律写成 `[r, g, b]`；命名常量放在生成脚本里，这里只管画 */
export const WHITE = [255, 255, 255];

export class Canvas {
  /**
   * @param {number} width  像素宽
   * @param {number} height 像素高
   * @param {number[]} background 底色
   */
  constructor(width, height, background = WHITE) {
    this.width = width;
    this.height = height;
    /** 行优先的 RGB 字节表 —— 与 PNG 的扫描线布局一致，省一次拷贝 */
    this.pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      this.pixels[i * 3] = background[0];
      this.pixels[i * 3 + 1] = background[1];
      this.pixels[i * 3 + 2] = background[2];
    }
  }

  /** 落一个点。**越界静默丢弃**（画曲线时端点常溢出，为此抛错只会让调用处全是判断） */
  set(x, y, color) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const at = (py * this.width + px) * 3;
    this.pixels[at] = color[0];
    this.pixels[at + 1] = color[1];
    this.pixels[at + 2] = color[2];
  }

  /** 点是否在画布内（画文字时用来判断整行是否可见） */
  contains(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Bresenham 直线 */
  line(x0, y0, x1, y1, color) {
    let [x, y] = [Math.round(x0), Math.round(y0)];
    const [ex, ey] = [Math.round(x1), Math.round(y1)];
    const dx = Math.abs(ex - x);
    const dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x, y, color);
      if (x === ex && y === ey) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** 实心矩形（虚线的每一段、图例色块都用它） */
  fillRect(x, y, w, h, color) {
    for (let row = 0; row < h; row += 1) for (let col = 0; col < w; col += 1) this.set(x + col, y + row, color);
  }

  /** 折线：按点序列连直线 */
  polyline(points, color) {
    for (let i = 1; i < points.length; i += 1) {
      this.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], color);
    }
  }

  /**
   * 虚线。坐标轴**刻意不用虚线**：实线是"这是坐标轴"，虚线在这个项目里
   * 另有含义 —— 图里用虚线标"这条是辅助线/邻域"（见生成脚本的图注）。
   */
  dashedLine(x0, y0, x1, y1, color, dash = 6, gap = 5) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length === 0) return;
    const steps = Math.ceil(length / (dash + gap));
    for (let i = 0; i < steps; i += 1) {
      const from = (i * (dash + gap)) / length;
      const to = Math.min(1, (i * (dash + gap) + dash) / length);
      this.line(x0 + (x1 - x0) * from, y0 + (y1 - y0) * from, x0 + (x1 - x0) * to, y0 + (y1 - y0) * to, color);
    }
  }

  /** 空心方框（标出"关键点"比一个 1×1 的点更容易看见） */
  box(x, y, size, color) {
    this.line(x - size, y - size, x + size, y - size, color);
    this.line(x + size, y - size, x + size, y + size, color);
    this.line(x + size, y + size, x - size, y + size, color);
    this.line(x - size, y + size, x - size, y - size, color);
  }

  /**
   * 画一行 ASCII 文字。`scale` 是整数放大倍数（1 ⇒ 5×7 像素）。
   *
   * 返回值是**这一行占的宽度**，方便调用处右对齐或画下划线。
   * 字符表由 `font5x7.mjs` 提供；画不出的字符会画出方框（不静默留白）。
   */
  text(content, x, y, color, scale = 1) {
    let cursor = x;
    for (const char of content) {
      const rows = glyphFor(char);
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let col = 0; col < GLYPH_WIDTH; col += 1) {
          if (rows[row][col] !== '1') continue;
          // 一个字形像素放大成 scale×scale 的方块，否则放大后会有空洞
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              this.set(cursor + col * scale + dx, y + row * scale + dy, color);
            }
          }
        }
      }
      cursor += (GLYPH_WIDTH + GLYPH_GAP) * scale;
    }
    return cursor - x - GLYPH_GAP * scale;
  }

  /**
   * 编码成 PNG。**只支持**色彩类型 2（真彩 RGB）、位深 8、隔行 0 ——
   * 也就是本文件唯一会产出的形态。要存别的形态得先扩这里，而不是指望它已经支持。
   */
  toPng() {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // 位深
    ihdr[9] = 2; // 色彩类型：真彩 RGB
    ihdr[10] = 0; // 压缩方法：deflate（PNG 只定义了这一种）
    ihdr[11] = 0; // 过滤方法：自适应（PNG 只定义了这一种）
    ihdr[12] = 0; // 隔行：无

    /*
     * 每行前面要加一个**过滤字节**。这里一律用 0（None）：
     * 我们的图是大片纯色背景，过滤器省下的那点体积远不如"输出确定"重要 ——
     * 逐字节可复现是 verify 能比对的前提。
     */
    const stride = this.width * 3;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let row = 0; row < this.height; row += 1) {
      raw[row * (stride + 1)] = 0;
      this.pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
    }

    // level 写死 9：zlib 的参数会影响字节流，不写死就没有可复现性可言
    const idat = deflateSync(raw, { level: 9 });
    return Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

/**
 * 读回一张 PNG 的宽高（只解析签名 + IHDR 的前 16 字节）。
 *
 * 校验脚本用它确认"仓库里那份确实是 PNG、确实是这个尺寸" ——
 * 不去解码像素，因为**这里要验的是"文件是不是真图"**，不是"画得好不好看"。
 * 画得好不好看只能靠人看，脚本不该假装能判断。
 *
 * 不是 PNG（签名不符）返回 `null`，由调用方报错。
 */
export function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
