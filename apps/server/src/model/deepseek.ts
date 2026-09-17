/**
 * 默认通道：DeepSeek API（说明书 V1.4）
 *
 * 由本文件（C 维护的 HTTP 适配器）向 B 提供统一 `ModelCaller`；
 * 教学模块与接口层不感知底层供应商。
 *
 * ### 依据与边界
 *
 * 选型依据负责人 2026-09-17 最新要求，以及其反馈的**平台调用超时问题**
 * （SDK 通道实测文字 12–21 秒、图片 17.7 秒，撑不住"30 秒得到解释"的口径）。
 * 本次调整**替代 V1.3 禁用 DS 的决定**；历史判断与失效记录保留在
 * `docs/tech/2026-09-17-模型通道-主路与备选.md`，不改写历史。
 *
 * 需明确：本通道**不是**"DS 已通过验收"或"已获赛事许可"的声明。
 * 负责人转述的赛事方口径（"最终效果呈现时最好不要包含第三方 AI"）与本次选型决策一并保留；
 * 学生界面不展示供应商品牌，**不等于获得规则豁免**。技术记录、启动日志与
 * `GET /api/health` 均如实报告 DS，不把 DS 调用标成 LearnBuddy 能力。
 *
 * ### 技术说明
 *
 * - DeepSeek 提供 OpenAI 兼容的 `POST /chat/completions`。
 * - 图片按 OpenAI 兼容惯例以 data URI 放在 `image_url` 里。
 *   **该格式已于 2026-09-17 用真实密钥实测通过**（正确转写 `f(x)=x³−3x` 与临界点 `x=±1`）；
 *   若上游将来变更格式，只需改下面 `toMessages` 一处。
 * - 响应会把实际服务的型号回显在 `model` 字段、用量回显在 `usage` 字段。
 *   说明书 V1.4 §5.2 要求"**返回值可用时记录实际型号**"，因此两者都记入
 *   `model.call.meta` 日志；配置里的 `DEEPSEEK_MODEL` 只是**请求**型号，二者未必相同。
 * - 失败时保留 `error.cause` 链：Node 的 `fetch` 只抛 `TypeError: fetch failed`，
 *   真正原因（DNS、证书、连接被拒、代理）在 `cause` 上 —— 云端排障全靠它。
 */

import type { ModelCallOptions, ModelInput } from '@lc/teaching';
import type { ModelErrorCode } from '@lc/contracts';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { ModelError, redact } from './errors.js';
import type { ModelAdapter } from './index.js';

/**
 * JSON 输出要求，注入提示词。
 *
 * 说明：DeepSeek 支持 `response_format: json_object`，但**尚未独立验证**
 * （说明书 V1.4 明确要求"DS的JSON输出能力需独立验证"，且不能套用 SDK 的结论）。
 * 在验证之前不使用该字段 —— 它与提示词方式并存时行为不一致，反而增加不确定性。
 * 无论是否启用，B 都必须做运行时字段与来源校验。
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

/**
 * 展平错误链。
 *
 * `fetch` 失败的报错只有一句 `TypeError: fetch failed`，DNS／证书／连接被拒／代理
 * 都在 `error.cause` 上。只取 `String(error)` 会让云端排障拿不到任何可用信息，
 * 而 V1.4 把"云端独立验证"列为唯一挡住交付的事项。
 */
function describeError(error: unknown, limit = 4): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < limit && current !== undefined && current !== null; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' ← ');
}

/** 上游响应里本适配器关心的字段（其余不读取） */
interface ChatCompletionBody {
  model?: string;
  usage?: unknown;
  choices?: { message?: { content?: string } }[];
}

export function createDeepseekAdapter(): ModelAdapter {
  return {
    name: 'deepseek',
    isMock: false,
    call: async (input, options = {}) => {
      if (!env.deepseekApiKey) {
        throw new ModelError(
          'AUTH',
          '缺少 DEEPSEEK_API_KEY，默认通道无法调用。请在 apps/server/.env 中配置；' +
            '若只想本地开发，请显式设 MODEL_PROVIDER=mock。',
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
            `模型通道返回 ${response.status}`,
            detail || undefined,
          );
        }

        const data = (await response.json()) as ChatCompletionBody;
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new ModelError('UPSTREAM', '模型通道返回内容为空。');
        }
        // 说明书 V1.4 §5.2：返回值可用时记录**实际型号**；用量一并留痕，
        // 便于核对额度与成本（说明书 5.2 要求确认额度）。实际型号与配置不符时，
        // 这行日志是唯一能发现的地方 —— 例如上游是网关、把型号名照收不误。
        logger.info('model.call.meta', {
          requestedModel: env.deepseekModel,
          actualModel: data.model,
          usage: data.usage,
        });
        return content;
      } catch (error) {
        if (error instanceof ModelError) throw error;
        if (controller.signal.aborted) {
          throw new ModelError('TIMEOUT', `模型通道超过 ${timeoutMs} 毫秒未返回，已中止，可重试。`);
        }
        throw new ModelError(
          'UPSTREAM',
          '模型通道调用失败。',
          redact(describeError(error), [env.deepseekApiKey]),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
