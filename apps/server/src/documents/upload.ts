/**
 * 文档上传：校验 → 算哈希 → 查重 → 落盘 → 入库（此时状态还是 uploaded）。
 *
 * 落盘文件名用【内容的 sha256】，不是原始文件名。这样做的三个好处：
 *   1. 文件系统天然成为去重表 —— 同内容不可能出现第二份文件。
 *   2. 不用在文件名里塞时间戳/随机数来避免冲突，名字本身就是内容标识。
 *   3. 原始文件名里的空格、中文、括号、路径分隔符全都不需要处理，
 *      不可能出现路径穿越（`../../etc/passwd` 这种）。
 *
 * 这个函数【不做解析与建索引】，那是 ingest.ts 的事，由路由层接着调用。
 * 只把行插成 uploaded，索引成功后才由 ingest 置 ready。
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { AppError, MATERIALS, type Material } from '@knowpilot/shared';
import { embeddingModelKey, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { findByContentHash } from './repo.ts';

/** 允许的扩展名。`.doc` 单独处理，见下。 */
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.txt']);

/** 单文件上限。论文 PDF 通常几 MB，扫描件可能到几十 MB。 */
const MAX_BYTES = 50 * 1024 * 1024;

export interface UploadInput {
  file: File;
  /** 原始字符串，在函数内校验，避免调用方用类型断言蒙混过关 */
  material: string;
  title?: string;
  /**
   * 上传者。**为 null 表示没有身份**（验证脚本直接调本函数）。
   *
   * 历史行的这一列是 NULL，它们是"公共历史数据"（见 auth/scope.ts）。
   * 不给旧数据回填一个事后追认的上传者 —— 那是编造，而这一列存在的
   * 唯一目的就是"能追到人"。
   */
  uploadedBy: string | null;
  /**
   * 谁确认了「内容会进知识库、检索命中的片段会发往云端」。
   *
   * 【为什么必须和 uploadedBy 分开两个字段】上传者与确认者**通常是同一个人，
   *   但不是必然**：运维代传、或者将来出现"别人代录"的流程时，确认这个动作
   *   发生了没有、是谁做的，是两件事。合成一列之后，那个差异就永远丢了。
   *
   * 这一列为 null 指的是"**没有记录**"（阶段 1–3 的记录都没有），
   * 与"记录下来了：他没有确认"不是一回事 —— 界面上不能把前者显示成后者。
   */
  consentConfirmedBy: string | null;
}

export interface UploadResult {
  /** 文档 id。调用方据此取摘要、接着跑 ingest。 */
  documentId: string;
  duplicated: boolean;
}

export interface StagedDocumentOriginal {
  path: string;
  finalSourcePath: string;
  promote: () => void;
  rollbackPromotion: () => void;
  dispose: () => void;
}

export interface PreparedDocumentUpload {
  id: string;
  material: Material;
  title: string;
  fileName: string;
  sourcePath: string;
  contentHash: string;
  storeOriginal: () => void;
  stageOriginal: () => StagedDocumentOriginal;
  insert: (db: Db, stagedSourcePath?: string) => void;
}

/** Prepare an original without publishing a document row. */
export async function prepareDocumentUpload(cfg: AppConfig, input: UploadInput): Promise<PreparedDocumentUpload> {
  // ── 1. 校验 ────────────────────────────────────────────────
  const material = MATERIALS.find((m) => m === input.material);
  if (material === undefined) {
    throw new AppError(
      'invalid_argument',
      `未知的材料类型 "${input.material}"。可用：${MATERIALS.join(', ')}`,
    );
  }

  const validatedMaterial: Material = material;
  const fileName = input.file.name;
  const ext = extname(fileName).toLowerCase();

  // .doc 单独拦：它是 Word 97-2003 的老二进制格式，Node 生态里没有可靠的解析库。
  // 不单独处理的话，用户会在"上传成功"之后才在解析环节失败，白等一场。
  if (ext === '.doc') {
    throw new AppError(
      'invalid_argument',
      '.doc 是 Word 97-2003 的老二进制格式，暂不支持。请用 Word 打开后「另存为」.docx 再上传。',
    );
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError(
      'invalid_argument',
      `不支持的扩展名 "${ext}"。当前支持：${[...ALLOWED_EXTENSIONS].join('、')}`,
    );
  }

  const buf = Buffer.from(await input.file.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new AppError('invalid_argument', '文件内容为空。');
  }
  if (buf.byteLength > MAX_BYTES) {
    throw new AppError(
      'invalid_argument',
      `文件 ${(buf.byteLength / 1048576).toFixed(1)} MB，超过单文件上限 ${MAX_BYTES / 1048576} MB。`,
    );
  }

  const contentHash = createHash('sha256').update(buf).digest('hex');
  const absPath = join(cfg.uploadDir, `${contentHash}${ext}`);
  function storeOriginal() {
    mkdirSync(cfg.uploadDir, { recursive: true });
    if (!existsSync(absPath)) writeFileSync(absPath, buf);
  }

  // 存【相对仓库根】的路径，不是绝对路径也不是相对 cwd 的路径：
  // 绝对路径在项目目录整体挪走后全部失效；相对 cwd 的路径会随入口变化
  // （阶段 0 踩过的坑：npm -w 会把 cwd 切到子包）。显式转成 POSIX 分隔符，
  // 避免数据库里出现 `data\uploads\...` 这种只有 Windows 认识的写法。
  const sourcePath = relative(cfg.repoRoot, absPath).split('\\').join('/');

  const id = randomUUID();
  function stageOriginal(): StagedDocumentOriginal {
    mkdirSync(cfg.uploadDir, { recursive: true });
    const directory = mkdtempSync(join(cfg.uploadDir, '.draft-'));
    const path = join(directory, 'original' + ext);
    const finalPath = join(cfg.uploadDir, id + ext);
    const finalSourcePath = relative(cfg.repoRoot, finalPath).split('\\').join('/');
    let ownsFinal = false;
    const dispose = () => rmSync(directory, { recursive: true, force: true });
    const rollbackPromotion = () => { if (ownsFinal) rmSync(finalPath, { force: true }); };
    function promote() {
      const file = openSync(finalPath, 'wx');
      ownsFinal = true;
      try {
        writeFileSync(file, buf);
      } finally {
        closeSync(file);
      }
    }
    try {
      writeFileSync(path, buf);
      return { path, finalSourcePath, promote, rollbackPromotion, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
  const title = input.title?.trim() || fileName;
  function insert(db: Db, stagedSourcePath = sourcePath) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO documents
         (id, material, title, file_name, byte_size, source_path, content_hash,
          group_id, uploaded_by, status, created_at, consent_confirmed_by, consent_confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'uploaded', ?, ?, ?)`,
    ).run(id, validatedMaterial, title, fileName, buf.byteLength, stagedSourcePath, contentHash,
      input.uploadedBy, now, input.consentConfirmedBy, input.consentConfirmedBy === null ? null : now);
  }
  return { id, material, title, fileName, sourcePath, contentHash, storeOriginal, stageOriginal, insert };
}

export async function uploadDocument(db: Db, cfg: AppConfig, input: UploadInput): Promise<UploadResult> {
  const prepared = await prepareDocumentUpload(cfg, input);
  const existing = findByContentHash(db, prepared.contentHash, embeddingModelKey(cfg));
  if (existing !== undefined) return { documentId: existing.id, duplicated: true };
  prepared.storeOriginal();
  prepared.insert(db);
  return { documentId: prepared.id, duplicated: false };
}
