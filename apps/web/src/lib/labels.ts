/**
 * 状态文案与样式的**唯一映射表**。
 *
 * 为什么要集中：六态、验证状态、三类来源的文案会在卡片、图谱、依据详情、
 * 练习解析等多处出现。分散写会立刻漂移 —— 例如同一个 `unverified`
 * 在卡片上写"未验证"、在依据详情里写"待验证"，学生就会以为是两种状态。
 * 说明书 §4.3 要求"来源类别与验证状态"在界面层一致呈现，因此这里只留一份。
 */

import type {
  AnswerScope,
  MisconceptionKind,
  PrerequisiteStatus,
  QuizSource,
  SourceType,
  TutorMode,
  VerificationStatus,
} from '@lc/contracts';

/** 依赖六态（§3.2） */
export const STATUS_LABELS: Record<PrerequisiteStatus, string> = {
  LOCAL: '材料已覆盖',
  SUPPLEMENTED: 'AI 已补充',
  MISSING: '材料未覆盖',
  PENDING: '待确认',
  VERIFIED: '已验证',
  DISPUTED: '有争议',
};

/** 六态的口径说明：卡片上要让学生知道"这个判定是什么意思" */
export const STATUS_HINTS: Record<PrerequisiteStatus, string> = {
  LOCAL: '你的材料里有足以支持当前学习的说明，可以定位到原文。',
  SUPPLEMENTED: '材料原本没有，是系统按你的需要补的，已显著标注。',
  MISSING: '当前学习需要这块知识，但你上传的材料里没有解释。',
  PENDING: '依据不清晰或公式识别不完整，暂不下结论。',
  VERIFIED: '补充或推导内容已通过符号验证或人工核验。',
  DISPUTED: '验证未通过或来源冲突，需要人工确认。',
};

/** 需要学生补充的缺口状态：只有这两种才给「补上这一段」 */
export const NEEDS_SUPPLEMENT: readonly PrerequisiteStatus[] = ['MISSING', 'PENDING'];

/** 验证状态（§4.4） */
export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  symbolic: '已符号验证',
  human: '已人工核验',
  unverified: '未验证',
  failed: '验证未通过',
};

/** 三类来源（§4.3）。AI 补充内容必须显著标注，不降权。 */
export const SOURCE_LABELS: Record<SourceType, string> = {
  material: '来自讲义',
  derived: '基于材料的解释推导',
  'ai-supplement': 'AI 补充：非上传讲义内容',
};

/** 边界判定（§4.1） */
export const SCOPE_LABELS: Record<AnswerScope, string> = {
  'in-material': '材料明确包含',
  derivable: '可依据材料推导',
  'missing-prereq': '缺少前置知识',
  partial: '部分可答',
  'out-of-scope': '超出课程范围',
  'insufficient-question': '题目条件不足',
};

export const TUTOR_MODE_LABELS: Record<TutorMode, string> = {
  explain: '解释概念',
  hint: '给我提示',
  full: '查看完整解答',
};

export const QUIZ_SOURCE_LABELS: Record<QuizSource, string> = {
  fixed: '项目自编练习',
  material: '基于你的材料生成',
};

export const MISCONCEPTION_LABELS: Record<MisconceptionKind, string> = {
  'concept-misunderstanding': '概念误解',
  'calculation-error': '计算错误',
  'condition-omission': '条件遗漏',
  'recognition-error': '识别错误',
};

/** 验证状态对应的样式类名，供 CSS 上色 */
export function verificationClass(status: VerificationStatus): string {
  switch (status) {
    case 'symbolic':
    case 'human':
      return 'tag tag-verified';
    case 'failed':
      return 'tag tag-failed';
    default:
      return 'tag tag-unverified';
  }
}

/** 六态对应的样式类名 */
export function statusClass(status: PrerequisiteStatus): string {
  switch (status) {
    case 'LOCAL':
      return 'tag tag-local';
    case 'SUPPLEMENTED':
      return 'tag tag-supplemented';
    case 'VERIFIED':
      return 'tag tag-verified';
    case 'DISPUTED':
      return 'tag tag-failed';
    case 'PENDING':
      return 'tag tag-pending';
    default:
      return 'tag tag-missing';
  }
}
