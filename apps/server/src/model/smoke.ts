/**
 * 模型适配层冒烟脚本
 *
 * 用途：在真实密钥下逐条验证三条关键路径，输出脱敏 JSON 便于留痕。
 * 与业务契约无关，不写入任何会话或材料状态。
 *
 * 用法（须在 apps/server 目录下运行，或通过 npm 脚本，因为 .env 在那里）：
 *   npm run smoke:model:selfcheck     仅校验配置，不调用模型、不消耗额度
 *   npm run smoke:model:text          纯文字调用
 *   npm run smoke:model:structured    结构化输出（json_schema）调用
 *   npm run smoke:model:image <路径>   含图片调用（PNG/JPEG，≤5MB）
 *
 * 密钥由 apps/server/.env 的 CODEBUDDY_API_KEY 提供；
 * 脚本不接收密钥参数，也不落盘任何密钥。
 */

import { readFile } from 'node:fs/promises';
import type { ModelContentBlock, ModelRequest } from '@lc/contracts';
import { env } from '../env.js';
import { MAX_IMAGE_BYTES, createWorkbuddyModelClient } from './workbuddy.js';
import { ModelError, redact } from './errors.js';

const SYSTEM_PROMPT =
  '你是高数教学接口测试助手。只回答问题，不操作文件、不执行命令、不调用工具。';

const USAGE = [
  '用法：',
  '  npm run smoke:model:selfcheck           仅校验配置，不调用模型、不消耗额度',
  '  npm run smoke:model:text                纯文字调用',
  '  npm run smoke:model:structured          结构化输出（json_schema）调用',
  '  npm run smoke:model:image -- <图片路径>  含图片调用（PNG/JPEG，≤5MB）',
].join('\n');

/** 按文件头判断图片格式，不信任扩展名 */
function sniffMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  throw new Error('仅支持 PNG 或 JPEG 图片。');
}

function textRequest(): ModelRequest {
  return {
    systemPrompt: SYSTEM_PROMPT,
    purpose: 'smoke:text',
    content: [
      { type: 'text', text: '请用中文回答：函数 f(x)=x² 在 x=1 处的导数是多少？用一句话说明。' },
    ],
  };
}

/**
 * 结构化输出路径。
 *
 * 注意：2026-09-16 两次实测确认上游**不兑现** outputFormat，
 * 所以这条命令的作用是记录"确实没生效、需要提示词兜底"这一事实。
 * schema 仍按严格模式惯例书写（全字段 required ＋ additionalProperties:false），
 * 以便将来上游支持时可直接启用。
 */
function structuredRequest(): ModelRequest {
  return {
    systemPrompt: SYSTEM_PROMPT,
    purpose: 'smoke:structured',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'sourceKind'],
      properties: {
        answer: { type: 'string', description: '用一句话给出的解释' },
        sourceKind: {
          type: 'string',
          enum: ['material', 'derived', 'ai_supplement'],
          description: '该解释的来源类别',
        },
      },
    },
    content: [
      {
        type: 'text',
        text: '函数 f(x)=x² 在 x=1 处的导数是多少？请在未提供讲义材料的前提下作答，并标注来源类别。',
      },
    ],
  };
}

async function imageRequest(imagePath: string): Promise<ModelRequest> {
  const bytes = await readFile(imagePath);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${bytes.length} 字节，超过上限 ${MAX_IMAGE_BYTES} 字节（5MB）。`);
  }
  const mediaType = sniffMediaType(bytes);
  const content: ModelContentBlock[] = [
    {
      type: 'text',
      text: '请只转写图片中可见的数学公式和文字，再简短解释其内容。看不清请明确说明，不要猜测。',
    },
    { type: 'image', mediaType, dataBase64: bytes.toString('base64') },
  ];
  return { systemPrompt: SYSTEM_PROMPT, purpose: 'smoke:image', content };
}

function createClient() {
  return createWorkbuddyModelClient({
    apiKey: env.codebuddyApiKey,
    environment: env.codebuddyEnvironment,
    timeoutMs: env.modelTimeoutMs,
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'selfcheck';
  const client = createClient();

  if (command === 'selfcheck') {
    const check = client.selfCheck();
    process.stdout.write(`${JSON.stringify({ command, ...check }, null, 2)}\n`);
    if (!check.ok) {
      process.stderr.write('自检未通过，请先修配置。\n');
      process.exitCode = 1;
    }
    return;
  }

  let request: ModelRequest;
  if (command === 'text') {
    request = textRequest();
  } else if (command === 'structured') {
    request = structuredRequest();
  } else if (command === 'image') {
    const imagePath = args[1];
    if (!imagePath) throw new Error('image 命令需要图片路径。');
    request = await imageRequest(imagePath);
  } else {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  process.stderr.write(`开始 ${command} 调用（最多 60 秒，本次调用会消耗账户额度）…\n`);
  const result = await client.complete(request);
  const report = {
    command,
    ok: true,
    purpose: request.purpose,
    model: result.model,
    hadImage: result.hadImage,
    durationMs: result.durationMs,
    usage: result.usage,
    structuredOutput: result.structuredOutput ?? null,
    text: redact(result.text, [env.codebuddyApiKey]),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write('调用成功。请人工核对内容；调用成功不等于数学或识别结果已验收。\n');
}

main().catch((error: unknown) => {
  const secret = env.codebuddyApiKey;
  const payload =
    error instanceof ModelError
      ? { ok: false, code: error.code, message: error.message, detail: error.detail }
      : { ok: false, code: 'UNEXPECTED', message: redact(error, [secret]) };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write('调用未通过。\n');
  process.exitCode = 1;
});
