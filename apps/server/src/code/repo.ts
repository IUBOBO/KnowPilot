/**
 * 数据集管理的读写。数据库列名是 snake_case，对外契约是 camelCase，
 * 转换只在这一个文件里发生（与 documents/repo.ts、submissions/repo.ts 同一条约定）。
 */
import { randomUUID } from 'node:crypto';
import {
  ASSET_CHECK_RESULTS,
  type AssetCheckResult,
  type CodeAsset,
  type UpdateCodeAssetRequest,
  type DatasetProfile,
  type RecordRetrievalHit,
} from '@knowpilot/shared';
import type { Db } from '../db/index.ts';

interface AssetRow {
  id: string;
  project: string | null;
  name: string;
  location: string;
  host: string | null;
  access_note: string | null;
  notes: string | null;
  profile: string | null;
  documentation_id: string | null;
  last_check_result: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, project, name, location, host, access_note, notes, profile, documentation_id,
  last_check_result, last_checked_at, created_at, updated_at`;

/**
 * 列表顺序：先按项目分组，未填项目的排在最后，组内按名称。
 *
 * 【为什么未填项目的排最后而不是最前】它们没有归属，属于"还没整理"的一堆；
 * 放在开头会把有归属的那些挤下去，而后者才是用户来找的东西。
 * 与 01 号 §1 的做法一致：初期用「类别标签 + 目录树」替代全量知识地图。
 */
const ORDER_BY = `ORDER BY project IS NULL, project COLLATE NOCASE, name COLLATE NOCASE`;

/**
 * 结果列从库里读出来时只是 `TEXT`（**故意不加 CHECK 约束**，理由见迁移 v10）。
 * 这里把认不出的值收敛成 `unchecked` 而不是抛错：一条读不动的旧记录不该
 * 让整页打不开，而"未核对"是这里最保守、也最诚实的说法。
 */
function toResult(raw: string): AssetCheckResult {
  return (ASSET_CHECK_RESULTS as readonly string[]).includes(raw)
    ? (raw as AssetCheckResult)
    : 'unchecked';
}

function toAsset(row: AssetRow): CodeAsset {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    location: row.location,
    host: row.host,
    accessNote: row.access_note,
    notes: row.notes,
    profile: row.profile === null ? {} : JSON.parse(row.profile) as DatasetProfile,
    documentationId: row.documentation_id,
    lastCheckResult: toResult(row.last_check_result),
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCodeAssets(db: Db, limit: number): readonly CodeAsset[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM code_assets ${ORDER_BY} LIMIT ?`)
    .all(limit) as unknown as AssetRow[];
  return rows.map(toAsset);
}

/**
 * 按落盘位置找一条登记记录。
 *
 * 【为什么上传完成后要靠它去重】目标目录通常就是数据集目录，而这个目录
 * 很可能早就登记过了（用户先建了目录、登记了一条，然后把压缩包传进来）。
 * 每传完一次就插一条新的，会让同一个数据集在界面上出现好几遍，
 * 而"哪一条是真的"没有任何依据可判。所以先查：查到了就把那一条返回去，
 * 让调用方知道"这次是往一条已有记录上补文件"，而不是新建。
 *
 * 大小写不敏感：Windows 上 `D:/Data` 与 `d:/data` 是同一个目录，
 * 而用户的输入不一定记住当初是怎么敲的。
 */
export function findCodeAssetByLocation(db: Db, location: string): CodeAsset | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM code_assets WHERE location = ? COLLATE NOCASE LIMIT 1`)
    .get(location) as unknown as AssetRow | undefined;
  return row === undefined ? null : toAsset(row);
}

export function getCodeAsset(db: Db, id: string): CodeAsset | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM code_assets WHERE id = ?`).get(id) as
    | unknown as AssetRow
    | undefined;
  return row === undefined ? null : toAsset(row);
}

/** Reuse the evidence projection without exposing filesystem or access details. */
export function getCodeAssetEvidence(db: Db, id: string): RecordRetrievalHit | null {
  const asset = getCodeAsset(db, id);
  if (asset === null) return null;
  const fields = [
    { label: '名称', value: asset.name },
    { label: '更新时点', value: asset.updatedAt },
  ];
  if (asset.profile?.version) fields.push({ label: '登记版本', value: asset.profile.version });
  if (asset.profile?.format) fields.push({ label: '数据格式', value: asset.profile.format });
  if (asset.profile?.scale) fields.push({ label: '规模', value: asset.profile.scale });
  return {
    kind: 'record', recordType: 'M-CODE', recordId: asset.id, sourceVersion: asset.updatedAt,
    recordTitle: asset.name, recordUpdatedAt: asset.updatedAt, queryTime: new Date().toISOString(),
    excerpt: '', fields, matchedBy: ['structured'],
  };
}

/**
 * 只取一条记录的登记人。
 *
 * 【为什么不把 created_by 加进 CodeAsset 契约里】契约是前后端共用的，
 *   加一个字段就要同步改前端类型与界面 —— 而写入侧的归属判断是**服务端
 *   自己的事**，前端不需要知道"这条记录归谁"才能正确工作（4B 要显示
 *   "谁登记的"时再把它放进契约，那时它是给用户看的信息，不是权限判据）。
 *
 * 返回 `null` 表示这条记录不存在，与"存在但没有登记人"区分开：
 * 前者该 404，后者该按"公共历史数据"处理。
 */
export function getCodeAssetOwner(db: Db, id: string): { createdBy: string | null } | null {
  const row = db.prepare('SELECT created_by FROM code_assets WHERE id = ?').get(id) as unknown as
    | { created_by: string | null }
    | undefined;
  return row === undefined ? null : { createdBy: row.created_by };
}

/**
 * LIKE 的转义。理由同 submissions/repo.ts 里那一份：不转义的话，
 * 搜「2024_实验」里的 `_` 会变成"任意一个字符"，召回一堆不相干的记录。
 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 按关键词查已登记的数据集。给 `probe_dataset` 工具用。
 *
 * 匹配**名称 / 项目 / 路径**三处：用户问"数据集 Y 在哪"时给的线索可能是
 * 数据集名、可能是课题名、也可能直接是路径的一段，三处都试才不漏。
 *
 * 不复用 `listCodeAssets` 后再在内存里筛：那要求先把全部记录捞出来，
 * 而这里的调用方是模型，它的提问频率不受控 —— 把筛选放在 SQL 里，
 * 数据量涨上去也不用改。
 */
export function searchCodeAssets(
  db: Db,
  query: { keyword: string | undefined; limit: number; offset?: number },
): readonly CodeAsset[] {
  const { clause, params } = datasetSearch(query.keyword);
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM code_assets ${clause} ${ORDER_BY}, id LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset ?? 0) as unknown as AssetRow[];
  return rows.map(toAsset);
}

function datasetSearch(keyword: string | undefined) {
  if (!keyword?.trim()) return { clause: '', params: [] };
  const like = `%${escapeLike(keyword.trim())}%`;
  return {
    clause: `WHERE name LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\'
      OR notes LIKE ? ESCAPE '\\' OR access_note LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(profile) WHERE value LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM documents d WHERE d.id = code_assets.documentation_id AND d.title LIKE ? ESCAPE '\\')`,
    params: [like, like, like, like, like, like, like],
  };
}

export function countMatchingCodeAssets(db: Db, keyword?: string): number {
  const { clause, params } = datasetSearch(keyword);
  return (db.prepare(`SELECT COUNT(*) AS total FROM code_assets ${clause}`).get(...params) as { total: number }).total;
}

export function insertCodeAsset(
  db: Db,
  input: {
    name: string;
    location: string;
    project: string | null;
    host: string | null;
    accessNote: string | null;
    notes: string | null;
    profile?: DatasetProfile;
    documentationId?: string | null;
    /** 登记时顺手核对一次的结果（用户不用再点一下才知道本机看不看得到）。 */
    lastCheckResult: AssetCheckResult;
    /**
     * 登记人。**这一列决定谁能改这条记录**（见 app.ts 里的 owner-or-admin 判断），
     * 所以请求路径上永远不能传 null —— 传 null 等于"这条记录谁都能改"。
     * null 只留给验证脚本与从数据集上传自动建档的历史路径。
     */
    createdBy: string | null;
  },
  now: string,
): string {
  const id = randomUUID();
  // 登记必然伴随一次核对（调用方负责跑），所以 last_checked_at 就是 now ——
  // 不存在"写进去了但没核对过"的中间态。
  db.prepare(
    `INSERT INTO code_assets
       (id, project, name, location, host, access_note, notes, profile, documentation_id,
        last_check_result, last_checked_at, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project,
    input.name,
    input.location,
    input.host,
    input.accessNote,
    input.notes,
    input.profile === undefined ? null : JSON.stringify(input.profile),
    input.documentationId ?? null,
    input.lastCheckResult,
    now,
    now,
    now,
    input.createdBy,
  );
  return id;
}

/**
 * 可修改的字段 → 数据库列名。
 *
 * 【为什么写成一张表，而不是在 updateCodeAsset 里逐个 if】
 * 有这张表，"哪些字段能改"就只有一处定义。否则将来给契约加一个字段时，
 * 这里会**静默地不改它** —— 界面显示出"已保存"，那个字段却原封不动，
 * 而且没有任何迹象（与阶段 1 那五次"看起来成功了，实际没生效"同一类）。
 */
const PATCHABLE: readonly { key: keyof UpdateCodeAssetRequest; column: string }[] = [
  { key: 'name', column: 'name' },
  { key: 'location', column: 'location' },
  { key: 'project', column: 'project' },
  { key: 'host', column: 'host' },
  { key: 'accessNote', column: 'access_note' },
  { key: 'notes', column: 'notes' },
  { key: 'profile', column: 'profile' },
  { key: 'documentationId', column: 'documentation_id' },
];

/**
 * 修改一条记录。返回是否真的改到了行（没这条 id 就是 false）。
 *
 * 只写请求里**出现过**的字段：出现过但为 null / 空串 = 清空。区分方式见
 * shared 里 UpdateCodeAssetRequest 的注释。
 *
 * 拼 SET 子句是安全的：列名只来自上面那张常量表，值一律走占位符，
 * 用户输入永远不会被拼进 SQL 文本。
 */
export function updateCodeAsset(
  db: Db,
  id: string,
  patch: UpdateCodeAssetRequest,
  now: string,
): boolean {
  const sets: string[] = [];
  const values: (string | null)[] = [];

  for (const { key, column } of PATCHABLE) {
    const value = patch[key];
    // undefined = 这次修改没提这个字段（不是"改成空"）。用 in 判断也一样，
    // 但读属性在这里更省事，而 JSON 解析出来的对象不会有"显式的 undefined"。
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
  }
  if (sets.length === 0) return false;

  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const result = db
    .prepare(`UPDATE code_assets SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
  return Number(result.changes) > 0;
}

/**
 * 删掉一条**登记记录**。
 *
 * ⚠️ 只删数据库里这一行，**绝不对 `location` 指向的路径做任何写操作**。
 * 这不是"暂时没做"，是**不该做**：数据集往往是整个课题组的资产，躺在共享盘上，
 * 一个网页按钮能把它删掉才是灾难。而且这份服务对那片数据本来就只该有读权限
 * —— 所以哪怕将来有人手滑加了个"顺手清理文件"，也应当在文件系统那一层失败。
 */
export function deleteCodeAsset(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM code_assets WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/**
 * 把一批核对结果写回。逐条 UPDATE 而不是一条 SQL 拼出来：
 * 每条的结果不同，拼 SQL 就要拼一堆 CASE WHEN，出错时很难看出是哪条写错了。
 * 包在一个事务里 —— 一次核对要么整批生效、要么整批不生效，
 * 半个批次的结论比没有结论更容易误导。
 */
export function saveCheckResults(
  db: Db,
  results: readonly { id: string; result: AssetCheckResult }[],
  now: string,
): void {
  const stmt = db.prepare(
    'UPDATE code_assets SET last_check_result = ?, last_checked_at = ?, updated_at = ? WHERE id = ?',
  );
  db.exec('BEGIN');
  try {
    for (const r of results) stmt.run(r.result, now, now, r.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
