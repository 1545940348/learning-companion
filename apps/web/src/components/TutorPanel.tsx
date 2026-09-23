/**
 * ⚠️ **兼容垫片（deprecated）** —— 真正的组件是 `ConversationView`。
 *
 * 2026-09-23 的 L 档改造把「答疑面板」演化成**主栏对话流**（消息正序、输入区在底部），
 * 文件随之更名为 `ConversationView.tsx`。本文件保留一个**再导出**，只为两件事：
 *
 * 1. 既有调用点不至于因为改名而中断（`scripts/verify-render.tsx` 已迁到 `ConversationView`，
 *    但外部若有引用不会突然炸）；
 * 2. 让"这个面板去哪了"这件事有迹可循 —— 比起让文件凭空消失，留一个指向新名字的垫片更好查。
 *
 * 📌 **清理说明**：本环境**删除文件的能力受限**（`safe-delete` 在 MSYS 路径下失败），
 * 因此没有直接删掉它。能在自带终端操作时，可执行 `git rm apps/web/src/components/TutorPanel.tsx`。
 * 在那之前，它只是一行再导出，不参与任何逻辑。
 */

export { ConversationView as TutorPanel } from './ConversationView';
