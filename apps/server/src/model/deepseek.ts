/**
 * 备选通道：DeepSeek（第三方）
 *
 * ⚠️ 合规边界（赛事方原话）
 * 「本次赛事以腾讯 LearnBuddy 平台为载体，最终效果呈现时最好不要包含第三方 AI」
 *
 * 因此本通道有三条硬性约束：
 * 1. **默认不可达** —— 只有显式设置 `MODEL_PROVIDER=deepseek` 才会启用；
 * 2. **不参与自动降级** —— 主通道失败时绝不会自动切到这里，
 *    因为自动切换恰好发生在"要呈现给评委"的那一刻，正好撞在约束上；
 * 3. **启用时喊出来** —— 启动日志打印醒目警告，`GET /api/health` 如实报告
 *    `modelProvider=deepseek` 与 `mock=false`。
 *
 * 定位：本地开发对比、以及在规则允许或需要应急时**手动**启用。
 * 不得用于作品的最终效果呈现（演示、评委体验）。
 *
 * 技术说明：DeepSeek 提供 OpenAI 兼容的 `/chat/completions`。
 * 图片按 OpenAI 兼容惯例以 data URI 放在 `image_url` 里 ——
 * **该格式尚未用真实密钥实测**，若上游返回格式错误，只需改下面 toMessages 一处。
 */

import type { ModelCallOptions, ModelInput } from '@lc/teaching';
import type { ModelErrorCode } from '@lc/contracts';
import { env } from '../config/env.js';
import { ModelError, redact } from './errors.js';
import type { ModelAdapter } from './index.js';

/**
 * 与主通道保持一致的 JSON 要求。
 *
 * 有意不使用 DeepSeek 原生的 `response_format: json_object`：
 * 两条通道对 B 的行为应当一致，而主通道（SDK）无法使用该字段（上游不兑现）。
 * 若将来确认 DS 的该字段稳定可用，可单独为备选通道启用，但需同步更新本注释与文档。
 */
const JSON_INSTRUCTION =
  '只输出一个 JSON 对象。不要使用 markdown 代码块包裹，不要输出任何解释文字。';

interface ChatMessage {
  role: 'system' | 'user';
  content: string | ChatContentPart[];
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 把教学模块的输入转成 OpenAI 兼容的消息格式 */
function toMessages(input: ModelInput, options: ModelCallOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const system = [options.system, options.json ? JSON_INSTRUCTION : undefined]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
  if (system) {
    messages.push({ role: 'system', content: system });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  const parts: ChatContentPart[] = input.map((block): ChatContentPart =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` } },
  );
  messages.push({ role: 'user', content: parts });
  return messages;
}

/** HTTP 状态码 → 与主通道一致的错误分类，便于前端按类给出下一步 */
function classifyStatus(status: number): ModelErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'QUOTA';
  if (status >= 500) return 'UPSTREAM';
  return 'INVALID_REQUEST';
}

export function createDeepseekAdapter(): ModelAdapter {
  return {
    name: 'deepseek',
    isMock: false,
    call: async (input, options = {}) => {
      if (!env.deepseekApiKey) {
        throw new ModelError(
          'AUTH',
          '缺少 DEEPSEEK_API_KEY，备选通道无法调用。请在 apps/server/.env 中配置，或改回 MODEL_PROVIDER=auto。',
        );
      }

      const base = env.deepseekBaseUrl.replace(/\/+$/, '');
      const timeoutMs = options.timeoutMs ?? env.modelTimeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.deepseekApiKey}`,
          },
          body: JSON.stringify({
            model: env.deepseekModel,
            messages: toMessages(input, options),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // 上游错误正文可能回显请求头，先脱敏再决定是否携带
          const detail = redact(await response.text().catch(() => ''), [env.deepseekApiKey]).slice(0, 500);
          throw new ModelError(
            classifyStatus(response.status),
            `备选通道返回 ${response.status}`,
            detail || undefined,
          );
        }

        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new ModelError('UPSTREAM', '备选通道返回内容为空。');
        }
        return content;
      } catch (error) {
        if (error instanceof ModelError) throw error;
        if (controller.signal.aborted) {
          throw new ModelError('TIMEOUT', `备选通道超过 ${timeoutMs} 毫秒未返回，已中止，可重试。`);
        }
        throw new ModelError('UPSTREAM', '备选通道调用失败。', redact(error, [env.deepseekApiKey]));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
