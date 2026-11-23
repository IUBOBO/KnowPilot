/**
 * 数据集整理（阶段 3 增补 B）。
 *
 * 【这一类和其它模块的根本差别】本项目对数据集目录一直是**只读**姿态
 * （`code/repo.ts` 的 deleteCodeAsset 明写"这份服务对那片数据本来就只该有
 * 读权限"，`01 §6.1` 直接写着「写入 文件系统 ❌ 默认禁止」）。整理是**第一个
 * 会改真实数据的模块** —— 所以它的重点从来不是"能移动"，而是**移动的边界
 * 与可追溯**：
 *   · Agent 只拟计划，**永不执行**（工具面上根本没有执行工具，是结构保证）；
 *   · 所有路径必须落在**该数据集自己的目录内**（服务端判，不信模型给的路）；
 *   · 预览即所见 —— 执行请求要带上用户确认过的条数，对不上就拒；
 *   · 计划先落库（pending）再执行，每个动作单独记一行。
 *
 * 【为什么不把契约做成固定 schema 的表单】2026-10-07 澄清过：真流程是
 * 「数据集上传完成 → 白话文沟通 → Agent 拟一份计划 → 用户确认或修改 → 再执行」。
 * 计划不是一份预先定好字段的台账，是一次对话现场拟出来的产物，所以这里
 * 只约束**规则**（glob → 目录）这一层最小结构，说明文字一律是自由文本。
 */

/**
 * 整理计划的四个状态。pending 是"已落库、尚未执行" —— 这个中间态是可追溯性的关键。
 *
 * 【为什么 undone 是独立状态而不是把 executed 改回去】"执行过、后来被撤销了"
 * 与"从没执行过"是两件事：前者在磁盘上留下过痕迹（可能新建了空目录），
 * 历史里必须还能看出它发生过。撤销不覆盖执行记录，只把状态再往后推一格。
 */
export const ORGANIZE_PLAN_STATUSES = ['pending', 'executed', 'failed', 'undone'] as const;

export type OrganizePlanStatus = (typeof ORGANIZE_PLAN_STATUSES)[number];

/** 单个动作的结局。部分失败要如实记，所以 done/skipped/failed 三态都要有。 */
export const ORGANIZE_ACTION_STATUSES = ['done', 'skipped', 'failed'] as const;

export type OrganizeActionStatus = (typeof ORGANIZE_ACTION_STATUSES)[number];

export const ORGANIZE_ACTION_KINDS = ['mkdir', 'move'] as const;

export type OrganizeActionKind = (typeof ORGANIZE_ACTION_KINDS)[number];

/**
 * 一条整理规则：把匹配到的文件移到某个目录。
 *
 * `match` 与 `toDir` 都是**相对数据集根**的 POSIX 路径 —— 收相对路径而不是
 * 绝对路径，是因为绝对路径等于把"越界判断"交给模型去做。相对路径由服务端
 * 拼上数据集根、再过 `assertInsideDir` 兜底，越界不可能发生。
 */
export interface OrganizeRule {
  /** glob，相对数据集根，如 `**\/*.png`、`train\/*.txt`。 */
  match: string;
  /** 目标目录，相对数据集根。文件移进去之后保持原名（重名不覆盖，见下）。 */
  toDir: string;
  /** Agent 写的白话说明（展示用），可选。 */
  note?: string;
}

export interface OrganizePlan {
  /** 给用户看的一段白话说明。 */
  summary: string;
  rules: readonly OrganizeRule[];
}

/** 单条规则的预览结果。 */
export interface OrganizeRulePreview {
  match: string;
  toDir: string;
  /** 命中多少个文件（剔除落在目标子树内的候选之后）。 */
  matched: number;
  /** 前若干个命中路径，供人核对"它是不是真的挑对了"。 */
  sample: readonly string[];
  /**
   * 这条规则本身的问题（glob 非法、目标越界、命中 0 条…）。
   * **有问题就要写出来，不静默吞掉** —— 一条"看起来通过了、其实什么都没做"
   * 的规则，比一条明确报错的规则危险得多。
   */
  problem?: string;
}

/** 整份计划的预览。用户看着它决定要不要点执行。 */
export interface OrganizePreview {
  rules: readonly OrganizeRulePreview[];
  /** 会实际移动的文件总数。执行请求的 expectedMoves 必须等于它。 */
  totalMoves: number;
  /** 会新建的目录（只列真有文件落进去的，不列空目录）。 */
  createdDirs: readonly string[];
  /** 目录里既没被任何规则覆盖、也不在任何目标目录下的文件数。 */
  untouched: number;
  warnings: readonly string[];
}

/** 对话里的一条消息。 */
export interface OrganizeMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 预览响应。
 *
 * 【为什么预览要单独一个接口、而不是在生成计划时就一起给】
 *   用户可以在界面上**手工改规则**（这是开工前拍板的「修改」两种方式之一）。
 *   改了之后必须重新算 —— 让前端自己算命中数等于把匹配逻辑抄一遍到浏览器里，
 *   两边早晚会不一致。所以预览永远是服务端算的，改一次问一次。
 */
export interface OrganizePreviewResponse {
  preview: OrganizePreview;
}

/**
 * 生成计划。
 *
 * 【为什么把整段对话一起传上来，而不是让服务端记住】多轮状态若留在服务端，
 * 就多了一份"这个用户现在聊到哪了"的存根要维护、要清理、要处理并发的两个
 * 标签页。把对话记录随请求带走，服务端就是无状态的 —— 代价只是每轮重新
 * 探一次目录（几次只读的工具调用，很便宜）。
 */
export interface OrganizeGenerateRequest {
  messages: readonly OrganizeMessage[];
  /** 与提问入口同一条闸门：内容会发往云端模型，必须显式勾选确认。 */
  consentConfirmed: boolean;
}

export interface OrganizeGenerateResponse {
  /** Agent 这轮的回复（白话）。 */
  reply: string;
  /**
   * 这轮提交的计划。`null` = 它选择先问一句、没出计划（信息不足时的正确行为）。
   * 这不是错误，界面上当成一次普通回复展示即可。
   */
  plan: OrganizePlan | null;
}

/**
 * 执行计划。
 *
 * 【为什么必须带 `expectedMoves`】用户点"确认并执行"时看到的是预览算出来的
 * "将移动 120 个文件"。从预览到执行之间，数据集可能被人动过（另一台上传、
 * 手工放了文件）。若不带这个数，执行的就是"按现在的磁盘状态重新匹配一遍"，
 * 而它可能已经不是用户确认的那件事了 —— 那时"用户确认"就只是走个形式。
 * 对不上就 400 要求重新预览，这是边界 ② 的实质。
 */
export interface OrganizeExecuteRequest {
  plan: OrganizePlan;
  expectedMoves: number;
  /** 二次确认。同 consentConfirmed：接口层自己拦，不靠界面禁用按钮。 */
  confirmed: boolean;
}

/** 执行结果里的一个动作。 */
export interface OrganizeActionRecord {
  action: OrganizeActionKind;
  fromPath: string | null;
  toPath: string;
  status: OrganizeActionStatus;
  reason: string | null;
}

export interface OrganizeExecuteResponse {
  planId: string;
  moved: number;
  skipped: number;
  failedCount: number;
  actions: readonly OrganizeActionRecord[];
}

/**
 * 撤销一次整理。
 *
 * 【为什么要 confirmed】撤销会移动真实文件 —— 与执行同一个量级。
 * 界面上有二次确认，接口层也必须自己拦（脚本和 curl 会绕开界面）。
 */
export interface OrganizeUndoRequest {
  confirmed: boolean;
}

/**
 * 撤销结果。
 *
 * 每个文件只有三种结局：移回原位（done）、跳过、失败。跳过不是错误：
 * 文件在整理之后被改动过、原件位置已经有同名文件、或者目标已经不在了 ——
 * 这三种情况都**不能动**，跳过并说明比冒险覆盖安全得多。
 */
export interface OrganizeUndoResponse {
  planId: string;
  /** 成功移回原位的文件数。 */
  restored: number;
  skipped: number;
  failedCount: number;
  actions: readonly OrganizeActionRecord[];
}

/** 整理历史里的一条。 */
export interface OrganizePlanSummary {
  id: string;
  summary: string;
  status: OrganizePlanStatus;
  plannedMoves: number;
  moved: number;
  failedCount: number;
  note: string | null;
  createdAt: string;
  executedAt: string | null;
  /** 撤销时间；没撤销过是 null。 */
  undoneAt: string | null;
  /** 成功移回原位的文件数。 */
  undoMoved: number;
  /** 撤销时被跳过（文件被改过/原位已被占/目标已不在）的文件数。 */
  undoSkipped: number;
  undoFailed: number;
  undoNote: string | null;
  /**
   * 这份计划此刻能不能撤销。
   *
   * 【为什么由服务端判、而不是界面按状态猜】"已执行"只是必要条件：
   * 撤销功能上线前执行的老计划**没有文件指纹**（大小 + mtime），
   * 无法确认目标位置还是当初那个文件 —— 那种计划必须拒绝撤销，
   * 否则就是把"用户以为能还原"变成一次盲移。界面只负责按这个布尔值
   * 显示或收起按钮，判据只有服务端一处。
   */
  undoable: boolean;
  /** 不能撤销时的原因（直接给用户看）；能撤销时为 null。 */
  undoBlockedReason: string | null;
}

export interface ListOrganizePlansResponse {
  items: readonly OrganizePlanSummary[];
}

/**
 * 探查时的目录深度上限。
 *
 * 数据集目录可以是任意深的树（解压出来的压缩包尤其能嵌套好几层）。不封顶
 * 的话，一个畸形目录能让扫描走出成千上万次 readdir。六层对这个用途够用：
 * 再深的目录，人也不会用 glob 去整理它。
 */
export const ORGANIZE_MAX_DEPTH = 6;

/**
 * 单次列目录返回给模型的**文件名样例**上限。
 *
 * 关键在"样例"：`list_dir` 返回聚合统计 + 这么多条样例，而不是把整个目录
 * dump 给模型。一个几十万文件的数据集，全量列出来会当场把上下文撑爆 ——
 * 而"信息够不够拟规则"和"能不能看见每一个文件"是两件事。
 */
export const ORGANIZE_LIST_LIMIT = 200;

/** 一轮对话里允许的探查（只读工具）次数上限。提交计划不计入。 */
export const ORGANIZE_MAX_TOOL_ROUNDS = 8;

/** 一轮对话的墙钟上限。与 ask 同一个量级：拟计划要比答一个问题多探几次，但也不该更久。 */
export const ORGANIZE_MAX_WALL_MS = 3 * 60 * 1000;

// ── glob 匹配 ────────────────────────────────────────────────
//
// 【为什么不引依赖、也不用 node:path 的 matchesGlob】
//   一是这个仓库至今只有 pi-ai / hono 等少数几个直接依赖，为一个十几行的
//   匹配函数加一个包不划算；二是 `path.matchesGlob` 是实验性 API，各版本
//   语义还在变，跨平台还可能不一致 —— 而"同一个 glob 在开发机和服务器上
//   匹配出不同的文件"这种问题，排查起来极其费劲。这里自己写一个确定的、
//   可单测的纯函数，语义写死在注释里。

/** 转义单个字符，让它只当字面量匹配。glob 的 `*` `?` 已在上面单独处理。 */
function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * glob → 正则。支持的语法（**只有这三种，其余一律当字面量**）：
 *
 *   `**`  跨段通配 —— 能吃掉 `/`。单独一个 `**` 匹配任意内容。
 *   `**\/ ` 见下：作为一个整体，匹配**零个或多个**目录段。
 *   `*`   段内通配 —— 不吃 `/`。所以 `*.png` 只匹配当前这一层的文件。
 *   `?`   段内单字符 —— 不吃 `/`。
 *
 * 【`**\/ ` 为什么要单独处理】`**\/*.png` 按"`**` 吃掉一切、再要一个 `/`"
 * 去翻，会匹配不到根目录下的 `a.png`（它前面没有 `/`）—— 而用户写这个
 * pattern 的意图恰恰是"所有 png，不管在第几层"。标准 glob 语义里 `**\/`
 * 是"零个或多个目录"，所以这里把 `**\/` 当成一个整体，展开成
 * `(?:[^/]+/)*`。这一处是整段代码里最容易写错、也最该被单测盯住的地方。
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` → 零个或多个目录段
          out += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        // 光秃秃的 `**` → 任意内容（含 `/`）
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegExpChar(ch ?? '');
    i += 1;
  }
  // 锚定两端：不锚的话 `*.png` 会匹配到 `a.png.bak` 的中间一段。
  return new RegExp(`^${out}$`, 'u');
}

/**
 * 一个相对路径是否匹配某个 glob。
 *
 * 大小写**敏感**：NTFS 虽然不区分大小写，但数据集里的扩展名通常是一致的，
 * 而"不区分大小写"会让 `*.TXT` 悄悄匹配到 `a.txt`，规则的效果变得难以预测。
 * 宁可让模型/用户写清楚的 pattern，也不用一个平台相关的隐式行为。
 */
export function matchesGlob(relPath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPath);
}
