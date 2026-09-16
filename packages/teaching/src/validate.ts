/**
 * 输出校验 —— 对应说明书 4.3 与用例 E7
 *
 * 校验失败的内容不得作为正常答案展示，应返回可重试错误。
 */

import type { AnswerBlock, SourceType, ValidatedAnswer } from '@lc/contracts';

/** 允许被引用的来源。由服务端根据当前会话的材料与补充块构造 */
export interface AllowedRef {
  refId: string;
  sourceType: SourceType;
  /** 来源全文，用于校验摘录能否定位 */
  text: string;
  /** 是否已获学生按需授权；仅 ai-supplement 需要为 true */
  authorized: boolean;
}

export interface ValidateOptions {
  /**
   * 是否要求 AI 补充内容必须绑定已授权的来源。
   *
   * - 材料路径下为 true：模型不得凭空引入材料之外的内容（用例 E7）。
   * - 零材料（轻路径）下为 false：学生主动提问即视为授权使用通用知识，
   *   此时回答必须由 `basedOnMaterial === false` 明确标注未基于材料（说明书 2.1）。
   */
  requireAuthorization: boolean;
}

const DEFAULT_OPTIONS: ValidateOptions = { requireAuthorization: true };

export function validateAnswerBlocks(
  blocks: AnswerBlock[],
  refs: AllowedRef[],
  options: ValidateOptions = DEFAULT_OPTIONS,
): ValidatedAnswer {
  const byId = new Map(refs.map((ref) => [ref.refId, ref]));
  const valid: AnswerBlock[] = [];
  const rejected: { block: AnswerBlock; reason: string }[] = [];

  for (const block of blocks) {
    const reason = findViolation(block, byId, options);
    if (reason === null) {
      valid.push(block);
    } else {
      rejected.push({ block, reason });
    }
  }

  return { valid, rejected };
}

function findViolation(
  block: AnswerBlock,
  byId: Map<string, AllowedRef>,
  options: ValidateOptions,
): string | null {
  // 材料路径下，未授权的 AI 补充内容不得作为正常答案返回（说明书 4.2）
  if (block.sourceType === 'ai-supplement' && options.requireAuthorization) {
    const authorized = block.citations.some((citation) => byId.get(citation.refId)?.authorized);
    if (!authorized) {
      return 'AI 补充内容未经学生授权';
    }
  }

  for (const citation of block.citations) {
    const ref = byId.get(citation.refId);
    if (!ref) {
      return `引用的来源不存在：${citation.refId}`;
    }
    if (ref.sourceType === 'ai-supplement' && !ref.authorized) {
      return `引用了未经授权的补充块：${citation.refId}`;
    }
    if (citation.excerpt.length > 0 && !ref.text.includes(citation.excerpt)) {
      return `摘录无法在来源中定位：${citation.refId}`;
    }
  }

  return null;
}
