/**
 * 给整理 Agent 的三个工具。**全部只读，除了 submit_plan 只往内存里送计划。**
 *
 * 【为什么工具面上没有"执行"】这是本模块最重要的一个结构决定：
 * Agent 能不能自己动手，不取决于提示词里写了多少遍"不要执行"，而取决于
 * **它手里根本没有那把枪**。这里没有 move、没有 mkdir、没有任何写盘能力，
 * 所以"用户没确认之前不会动数据"是一个编译期就成立的事实，
 * 而不是一句需要模型自觉遵守的嘱咐。（与"删除工具根本不存在于工具面上"
 * 同一条思路，见 docs/项目亮点与踩坑/项目进度.md。）
 *
 * 【路径一律用"相对数据集根"】收绝对路径等于把"越界判断"交给模型 ——
 * 它只要写一个 `../../..` 或者一个别的盘符就行。收相对路径 + 服务端拼根 +
 * `assertInsideDir` 兜底，越界在这条链路上不可能发生。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { ORGANIZE_LIST_LIMIT, ORGANIZE_MAX_DEPTH, type OrganizePlan } from '@knowpilot/shared';
import { AppError } from '@knowpilot/shared';
import { assertInsideDir, parseRelPath } from '../uploads/layout.ts';
import { scanFiles } from './scan.ts';

export const ORGANIZE_LIST_DIR = 'list_dir';
export const ORGANIZE_READ_FILE = 'read_file';
export const ORGANIZE_SUBMIT_PLAN = 'submit_plan';

/**
 * 允许读取内容的文本类扩展名。
 *
 * `read_file` 的用途很具体：让 Agent 能看一眼 `classes.txt`、`train.txt`
 * 这种清单文件，从而知道目录里那些编号对应什么。所以只放行确定是文本的类型 ——
 * 让模型去"读"一个 jpg 或一个几十 GB 的视频，读出来的要么是乱码要么是灾难。
 */
const TEXT_EXTS = ['.txt', '.csv', '.json', '.md', '.yaml', '.yml', '.list', '.tsv'];

/** read_file 默认与上限的字符数。默认够看一眼清单，上限够看一小段配置。 */
const READ_DEFAULT_CHARS = 4096;
const READ_MAX_CHARS = 20000;
/** 超过这个大小的文件直接拒绝，不做 utf8 解码 —— 解一个 1 GB 的文件会先吃光内存。 */
const READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 把模型给的"相对数据集根的路径"变成一个已验证的绝对路径。
 *
 * `''` / `undefined` / `'.'` 都表示数据集根自己 —— Agent 最先要看的通常是
 * 根目录长什么样，为此逼它写一个空路径不合理。
 */
function resolveRel(root: string, raw: unknown, what: string): { rel: string; abs: string } {
  if (raw === undefined || raw === null || raw === '' || raw === '.') {
    return { rel: '', abs: root };
  }
  const rel = parseRelPath(raw, what, '数据集根');
  const abs = join(root, rel);
  assertInsideDir(root, abs, what);
  return { rel, abs };
}

/** 扩展名（小写，含点）。没有扩展名返回 '(无扩展名)'。 */
function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '(无扩展名)';
  return base.slice(dot).toLowerCase();
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const ListDirParams = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        '要看的目录，**相对数据集根的路径**（例如 "train"、"annotations"）。' +
        '不填表示看数据集根目录。不要传绝对路径。',
    }),
  ),
  depth: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: ORGANIZE_MAX_DEPTH,
      description: `往下看几层，默认 1（只看这一层），最多 ${ORGANIZE_MAX_DEPTH} 层。`,
    }),
  ),
});

const ReadFileParams = Type.Object({
  path: Type.String({
    description:
      '要读的文本文件，相对数据集根的路径（例如 "classes.txt"、"train/list.txt"）。' +
      '只支持 .txt/.csv/.json/.md/.yaml 这类文本文件。',
  }),
  maxChars: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: READ_MAX_CHARS,
      description: `最多读多少个字符，默认 ${READ_DEFAULT_CHARS}。`,
    }),
  ),
});

const SubmitPlanParams = Type.Object({
  summary: Type.String({
    description:
      '给用户看的一段白话说明：你打算怎么整理、依据是什么、哪些东西你不会动。',
  }),
  rules: Type.Array(
    Type.Object({
      match: Type.String({
        description:
          'glob 模式，相对数据集根。支持 **（跨目录）、*（同一层内的任意字符）、?（单个字符）。' +
          '例如 "**/*.png" 匹配所有 png，"train/*.txt" 只匹配 train 这一层的 txt。',
      }),
      to_dir: Type.String({
        description: '把这些文件移到哪个目录，相对数据集根，例如 "images"。不存在会被创建。',
      }),
      note: Type.Optional(Type.String({ description: '这条规则的一句话说明（可选）。' })),
    }),
    { description: '整理规则清单，按顺序应用。' },
  ),
});

export type ListDirArgs = Static<typeof ListDirParams>;
export type ReadFileArgs = Static<typeof ReadFileParams>;
export type SubmitPlanArgs = Static<typeof SubmitPlanParams>;

export interface ListDirDetails {
  path: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * 列目录。
 *
 * 【为什么只回聚合 + 样例，而不是把文件全列出来】一个几十万文件的数据集全量
 * dump 出来会当场把上下文撑爆，模型还没开始拟规则就先被淹了。而拟规则需要的
 * 信息其实是聚合层面的："有多少个 png、它们大致在哪些子目录、文件名的形状
 * 是什么样"。所以这里给：总数、总字节、按扩展名的计数、按一级子目录的计数、
 * 以及前若干个路径作为样例。这既够拟规则，又不至于失控。
 */
export function createListDirTool(root: string): AgentTool<typeof ListDirParams, ListDirDetails> {
  return {
    name: ORGANIZE_LIST_DIR,
    label: '查看数据集目录',
    description:
      '查看数据集里某个目录的内容：文件总数、按扩展名与子目录的分布、以及一部分文件路径样例。' +
      '用它了解目录里到底有什么，再据此拟整理规则。路径是相对数据集根的。',
    parameters: ListDirParams,
    execute: async (_id, params): Promise<AgentToolResult<ListDirDetails>> => {
      const { rel, abs } = resolveRel(root, params.path, 'path');
      const depth = params.depth ?? 1;

      if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
        throw new AppError('invalid_argument', `目录不存在或不是一个目录：${rel === '' ? '.' : rel}`);
      }

      const scan = scanFiles(abs, depth);
      const prefix = rel === '' ? '' : `${rel}/`;

      const byExt = new Map<string, number>();
      let totalBytes = 0;
      for (const f of scan.files) {
        totalBytes += f.size;
        byExt.set(extOf(f.relPath), (byExt.get(extOf(f.relPath)) ?? 0) + 1);
      }

      // 一级子目录分布：把相对路径的第一段拿出来数。
      const bySub = new Map<string, number>();
      for (const f of scan.files) {
        const rest = f.relPath;
        const slash = rest.indexOf('/');
        const key = slash === -1 ? '(本层文件)' : rest.slice(0, slash);
        bySub.set(key, (bySub.get(key) ?? 0) + 1);
      }

      const extLine = [...byExt.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([ext, n]) => `${ext} × ${n}`)
        .join('，');
      const subLine = [...bySub.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([name, n]) => `${name}（${n} 个文件）`)
        .join('，');

      const sample = scan.files.slice(0, ORGANIZE_LIST_LIMIT).map((f) => `${prefix}${f.relPath}`);

      const lines = [
        `目录 ${rel === '' ? '(数据集根)' : rel}（往下 ${depth} 层）：`,
        `文件总数 ${scan.files.length}，合计 ${humanBytes(totalBytes)}。`,
        extLine === '' ? '（空目录）' : `按扩展名：${extLine}`,
        subLine === '' ? '' : `按子目录：${subLine}`,
        sample.length === 0 ? '' : `路径样例（前 ${sample.length} 个）：`,
        ...sample,
      ].filter((l) => l !== '');
      if (scan.truncated) {
        lines.push(`⚠️ 文件太多，本次只列了一部分，上面的计数不完整。`);
      }
      if (scan.unreadable.length > 0) {
        lines.push(`⚠️ 有 ${scan.unreadable.length} 个子目录读不动，其中的文件没算进来。`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { path: rel === '' ? '.' : rel, fileCount: scan.files.length, totalBytes },
      };
    },
  };
}

export interface ReadFileDetails {
  path: string;
  readChars: number;
  truncated: boolean;
}

/**
 * 读一个文本文件的前若干字符。
 *
 * 用途是让 Agent 看见 `classes.txt`／`train.txt` 这种**清单文件** —— 数据集里
 * 那一堆 `0001.jpg` 靠文件名看不出任何东西，但清单文件会写清编号对应什么。
 * 非文本类型、超大文件一律拒绝并说明原因，而不是返回一段乱码。
 */
export function createReadFileTool(root: string): AgentTool<typeof ReadFileParams, ReadFileDetails> {
  return {
    name: ORGANIZE_READ_FILE,
    label: '读取文本文件',
    description:
      '读取数据集里一个文本文件的内容（清单、说明、标注表这类）。' +
      `只支持 ${TEXT_EXTS.join('/')} 等文本类型，最多读前若干字符。`,
    parameters: ReadFileParams,
    execute: async (_id, params): Promise<AgentToolResult<ReadFileDetails>> => {
      const { rel, abs } = resolveRel(root, params.path, 'path');

      const st = statSync(abs, { throwIfNoEntry: false });
      if (st === undefined || !st.isFile()) {
        throw new AppError('invalid_argument', `文件不存在或不是一个文件：${rel}`);
      }

      const ext = extOf(rel);
      if (!TEXT_EXTS.includes(ext)) {
        throw new AppError(
          'invalid_argument',
          `${rel} 不是文本文件（类型 ${ext}）。这里只能读 ${TEXT_EXTS.join('/')} 这类文件。`,
        );
      }
      if (st.size > READ_MAX_BYTES) {
        throw new AppError(
          'invalid_argument',
          `${rel} 有 ${humanBytes(st.size)}，太大了，不读。`,
        );
      }

      const maxChars = Math.min(params.maxChars ?? READ_DEFAULT_CHARS, READ_MAX_CHARS);
      const text = readFileSync(abs, 'utf8');
      const truncated = text.length > maxChars;
      const body = truncated ? text.slice(0, maxChars) : text;

      return {
        content: [
          {
            type: 'text',
            text: `${rel}（${st.size} 字节${truncated ? `，只显示前 ${maxChars} 个字符` : ''}）：\n\n${body}`,
          },
        ],
        details: { path: rel, readChars: body.length, truncated },
      };
    },
  };
}

export interface SubmitPlanDetails {
  ruleCount: number;
}

/**
 * 提交整理计划。
 *
 * 与 `submit_answer` 同一条思路（见 agent/tools.ts）：把结构化输出做成工具调用，
 * 一方面拿到的是受控 JSON 而不是要去解析的自由文本，另一方面 `terminate: true`
 * 让循环在这里干净结束，不必猜"它说完了没有"。
 *
 * 【注意它只往一个内存回调里送数据】这个工具不落库、不碰磁盘。计划要不要变成
 * 真的动作，是用户在界面上单独点的一个 HTTP 请求 —— 见本文件顶部那段。
 */
export function createSubmitPlanTool(
  sink: (plan: OrganizePlan) => void,
): AgentTool<typeof SubmitPlanParams, SubmitPlanDetails> {
  return {
    name: ORGANIZE_SUBMIT_PLAN,
    label: '提交整理计划',
    description:
      '拟好规则后调用它提交整理计划。计算规则的实际效果由系统负责，你只需要写清规则本身。' +
      '调用它就代表这轮任务结束，不要再在回复正文里重复列出计划。',
    parameters: SubmitPlanParams,
    execute: async (_id, params): Promise<AgentToolResult<SubmitPlanDetails>> => {
      const rules = params.rules.map((r) => ({
        match: r.match,
        toDir: r.to_dir,
        ...(r.note !== undefined ? { note: r.note } : {}),
      }));
      sink({ summary: params.summary, rules });
      return {
        content: [{ type: 'text', text: '已收到计划。' }],
        details: { ruleCount: rules.length },
        terminate: true,
      };
    },
  };
}
