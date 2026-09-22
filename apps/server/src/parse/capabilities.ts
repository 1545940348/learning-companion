/**
 * 识别通道能力状态 —— 供 `GET /api/health` **如实报告**（说明书 V2.0 §5.2）。
 *
 * ### 为什么单独成文件
 *
 * 与 `routes.ts` 的 `VERIFICATION_ENGINE` 同理：把"能力从哪来"和"谁来消费"
 * 分开。`routes.ts` 只做一次引用，本文件负责声明。
 *
 * ### 为什么写死常量而不手写 `true/false` 到路由里
 *
 * `packages/teaching/src/symbolic.ts` 的 `SYMBOLIC_ENGINE` 用的就是
 * 「**模块存在即表示引擎可用**」：能力声明跟着实现走，实现被摘掉时
 * 声明也一起消失，不会出现"引擎没了、health 还说可用"的漂移。
 *
 * ### `audio.available = false` 是**事实陈述，不是待办**
 *
 * 语音**不由服务端转写**：`D3`（2026-09-19 拍板）定的路线是
 * 「浏览器内置 Web Speech API」，识别在**浏览器侧**发生。
 * 因此 `POST /api/parse` 的语音路径**依然是"未接入"**，
 * 界面必须把这件事**分开说明**（见 `tech/2026-09-17-托管载体与模型通道选型建议.md` §2.3）：
 * 「语音在浏览器内转成文字后进入文本路径」≠「服务端具备语音识别能力」。
 *
 * ⚠️ **2026-09-22 起这个 `false` 更容易被读错，`note` 必须写清"谁没有能力"**：
 * 界面上的「语音输入」已经能用了（`apps/web/src/components/VoiceInputButton.tsx`），
 * 而**服务端确实没有** ASR —— 两件事同时成立。
 * 只写"语音未接入"会被读成"语音功能坏了"，与实况不符。
 */

import type { RecognitionCapabilities } from '@lc/contracts';

/**
 * 图片：**服务端**经已接入的模型通道识别为文本。
 *
 * 依据：图片内容块 `{type:'image', mediaType, dataBase64}` 已由教学层与两条适配器实现，
 * 且 2026-09-17 用真实密钥实测通过（DS 3195 ms / SDK 17.7 s）。
 * 实现见同目录 `vision.ts`。
 */
const IMAGE_CAPABILITY = {
  engine: 'model-vision',
  available: true,
  note: '服务端识别：图片经已接入的模型通道转写为文本（PNG/JPEG，单张 ≤5MB）',
} as const;

/**
 * 语音：**服务端不具备 ASR**，按 `D3` 走浏览器内置识别（识别不在服务端发生）。
 *
 * `available: false` 说的是**服务端这一侧**没有这个能力，**不是**"语音输入用不了"。
 * 界面上的「语音输入」已接入（2026-09-22），由浏览器转成文字后按普通文本进入系统
 * —— 所以 `note` 必须把**主语**写出来，否则会被读成功能故障。
 */
const AUDIO_CAPABILITY = {
  engine: 'browser-speech',
  available: false,
  note:
    '服务端不转写语音（D3 拍板走浏览器内置识别）。界面上的「语音输入」由浏览器转成文字后' +
    '按普通文本进入系统 —— 这个 false 指的是「服务端没有这项能力」，不是语音输入不可用；' +
    '/api/parse 的语音路径仍未接入',
} as const;

export const RECOGNITION_CAPABILITIES: RecognitionCapabilities = {
  image: IMAGE_CAPABILITY,
  audio: AUDIO_CAPABILITY,
};
