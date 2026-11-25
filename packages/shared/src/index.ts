/**
 * @knowpilot/shared —— 前后端唯一的类型契约来源。
 *
 * 规则：任何跨进程传输的数据结构，只在这里定义一次。
 * 服务端 import 它，前端也 import 它。
 * 不要在前端手抄一遍"看起来一样"的 interface —— 那就等于没有契约。
 */

export * from './errors.ts';
export * from './text.ts';
export * from './documents.ts';
export * from './search.ts';
export * from './evidence-open.ts';
export * from './answer.ts';
export * from './answer-table.ts';
export * from './answer-preview.ts';
export * from './submissions.ts';
export * from './code-assets.ts';
export * from './uploads.ts';
export * from './organize.ts';
export * from './knowledge.ts';
export * from './patrol.ts';
// 回答反馈（O5）：评分、踩的预设原因、管理端列表与导出草稿共用一套形状。
export * from './feedback.ts';
// Role / ROLES / Permission / AuthUser 等都在这里，经本文件对外导出。
export * from './auth.ts';
export * from './me.ts';
export * from './admin.ts';
export * from './users.ts';
export * from './people.ts';
export * from './patents.ts';
export * from './theses.ts';
export * from './record-edits.ts';
export * from './ledger-imports.ts';
export * from './agent-tasks.ts';
// 系统配置的键名与模型目录（阶段 4C 单元 ③）：服务端解析、管理端页面、
// 命令行三处共用同一份常量，拼错键名变成编译错误。
export * from './system-config.ts';
// 管理端运行 Trace（O7）：只含过程元数据，不含回答正文与证据摘录。
export * from './trace.ts';
// ⌘K 命令面板（O10）：页面跳转 + 三类实体的短名单。
export * from './quick-search.ts';

/** /health 的响应体 */
export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  /** 当前数据库结构版本，等于已执行的迁移条数 */
  schemaVersion: number;
  /** 进程已运行秒数 */
  uptimeSec: number;
  /** ISO 8601 时间戳 */
  time: string;
}
