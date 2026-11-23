/**
 * 投稿台账的读写。数据库列名是 snake_case，对外契约是 camelCase，
 * 转换只在这一个文件里发生（与 documents/repo.ts 同一条约定）。
 */
import { randomUUID } from 'node:crypto';
import { AppError,
  type Journal,
  type JournalRanking,
  type Submission,
  type SubmissionHistoryEntry,
  type SubmissionRound,
  type SubmissionStatus,
} from '@knowpilot/shared';
import { listRecordEdits, recordEdit } from '../ledger/record-edits.ts';
import type { Db } from '../db/index.ts';
import type { RowScope } from '../auth/scope.ts';
import { scopePredicate } from '../auth/scope.ts';

interface SubmissionRow {
  id: string;
  title: string;
  status: string;
  submitted_at: string | null;
  submitted_on: string | null;
  algorithm_abbr: string | null;
  submitter_name: string | null;
  submitter_person_id: string | null;
  status_since: string | null;
  current_round_no: number | null;
  submission_number: string | null;
  updated_at: string;
  revision: number;
  created_at: string;
  notes: string | null;
  user_id: string | null;
  submitted_by_name: string | null;
  journal_id: string | null;
  journal_name: string | null;
  journal_abbr: string | null;
  journal_issn: string | null;
  journal_field: string | null;
  journal_website: string | null;
}

interface RankingRow {
  id: string;
  year: number;
  system: string;
  category: string;
  rank: string;
  top: number;
  note: string | null;
  source: string;
  verified: number;
  source_url: string | null;
  fetched_at: string;
}

/**
 * 分区行的列清单只写一次。
 *
 * 【为什么值得抽出来】v13 之后分区多了三列（category / top / note），
 * 而读取点有四处（台账单行、模型工具、分区库列表、联网回填的返回）。
 * 少抄一处，那一处的 `top` 就永远是 false —— 界面不报错，只是 Top 徽标
 * 在某个页面上默默消失。列名集中在这儿，加列时编译器会逼着改一处。
 */
const RANKING_COLUMNS = `id, year, system, category, rank, top, note, source, verified, source_url, fetched_at`;

/** 一行 → 对外契约。SQLite 没有 boolean，存的是 0/1。 */
function toRanking(row: RankingRow): JournalRanking {
  return {
    id: row.id,
    year: row.year,
    system: row.system,
    category: row.category,
    rank: row.rank,
    top: row.top === 1,
    note: row.note,
    source: row.source,
    verified: row.verified === 1,
    sourceUrl: row.source_url,
    fetchedAt: row.fetched_at,
  };
}

// 当前轮次的三个字段用标量子查询取 —— 列表页要显示“第几次投稿 / 稿件编号 /
// 本轮提交日期”，但它们属于轮次表。先保持 submissions.status / journal_id
// 作为“当前”的冗余指针，旧读取路径不用改。
const SUBMISSION_COLUMNS = `s.id, s.title, s.status, s.submitted_at,
  (SELECT r.submitted_on FROM submission_rounds r WHERE r.submission_id = s.id
     ORDER BY r.round_no DESC LIMIT 1) AS submitted_on,
  s.algorithm_abbr, COALESCE(s.submitter_name, pe.name) AS submitter_name, s.submitter_person_id, s.status_since,
  (SELECT r.round_no FROM submission_rounds r WHERE r.submission_id = s.id
     ORDER BY r.round_no DESC LIMIT 1) AS current_round_no,
  (SELECT r.submission_number FROM submission_rounds r WHERE r.submission_id = s.id
     ORDER BY r.round_no DESC LIMIT 1) AS submission_number,
  s.updated_at, s.revision, s.created_at, s.notes, s.user_id, u.display_name AS submitted_by_name,
  j.id AS journal_id, j.name AS journal_name, j.abbr AS journal_abbr,
  j.issn AS journal_issn, j.field AS journal_field, j.website AS journal_website`;

/**
 * 投稿记录 → 期刊 + 录入者。
 *
 * 【为什么两个都是 LEFT JOIN，一个都不能换成 JOIN】
 *   `journal_id` 可空（先记下"投了这篇"、刊名回头再补）；
 *   `user_id` 在阶段 1–3 的记录上**全是 NULL**（那时还没有登录）。
 *   换成内连接，这些记录会**从列表里整条消失** —— 用户刚录入的东西不见了，
 *   而库里明明有。这类"存进去了却看不到"最难排查。
 */
const SUBMISSION_FROM = `FROM submissions s
  LEFT JOIN journals j ON j.id = s.journal_id
  LEFT JOIN users u ON u.id = s.user_id
  LEFT JOIN people pe ON pe.id = s.submitter_person_id`;

/**
 * 按刊名找期刊，找不到就建一个。
 *
 * 【为什么是 find-or-create 而不是让用户先建期刊】
 *   台账录入时用户心里想的是"投了 Nature"，不是"投了 journal_id=xxx"。
 *   要求先建期刊再投稿，等于把一个动作拆成两个页面往返 ——
 *   而期刊本来就是台账的副产品（阶段 4 的管理端 /admin/journals 才是它的正主）。
 *
 * 比较用 COLLATE NOCASE，与 `idx_journals_name` 这个唯一索引同一口径：
 * 两边不一致的话，"Nature" 查不到就会去插入 "nature"，
 * 然后被唯一索引挡下来（查过一次没找到，再插却冲突）—— 那是最难解释的一种报错。
 *
 * 【已有期刊时 field 不覆盖】用户这次填的领域只用于新建。
 * 覆盖已有值意味着"同一本刊的领域由最后一次录入它的人决定"，
 * 而这是个共享字段，不同人填的粒度不一样（"计算机视觉" vs "CV"），
 * 谁最后录入谁说话会让它来回跳。要改领域走管理端（阶段 4）。
 */
export function findOrCreateJournal(
  db: Db,
  name: string,
  field: string | undefined,
  now: string,
): { id: string; created: boolean } {
  const trimmed = name.trim();
  const existing = db
    .prepare('SELECT id FROM journals WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(trimmed) as unknown as { id: string } | undefined;
  if (existing !== undefined) return { id: existing.id, created: false };

  const id = randomUUID();
  db.prepare(
    'INSERT INTO journals (id, name, issn, field, created_at) VALUES (?, ?, NULL, ?, ?)',
  ).run(id, trimmed, field ?? null, now);
  return { id, created: true };
}

export function insertSubmission(
  db: Db,
  input: {
    title: string;
    journalId: string | null;
    status: SubmissionStatus;
    submittedAt: string | null;
    notes: string | null;
    /** 录入者。阶段 1–3 建的记录没有归属，它们是"公共历史数据" */
    userId: string | null;
    /** 以下为台账信息优化（v23）新增，旧调用方可以不给。 */
    algorithmAbbr?: string | null;
    submitterName?: string | null;
    submitterPersonId?: string | null;
    statusSince?: string | null;
    /** 本轮次首次提交的日历日期；与 submittedAt 可并存（后者是旧时间戳）。 */
    submittedOn?: string | null;
    submissionNumber?: string | null;
  },
  now: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO submissions
       (id, user_id, title, journal_id, status, submitted_at, updated_at, notes, created_at,
        algorithm_abbr, submitter_name, submitter_person_id, status_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.title,
    input.journalId,
    input.status,
    input.submittedAt,
    now,
    input.notes,
    now,
    input.algorithmAbbr ?? null,
    input.submitterName ?? null,
    input.submitterPersonId ?? null,
    input.statusSince ?? null,
  );

  // 每条稿件至少有一轮投稿。低层插入函数也负责这一格，
  // 否则测试或导入脚本造的记录会变成“没有轮次的稿件”。
  db.prepare(
    `INSERT INTO submission_rounds
       (id, submission_id, round_no, journal_id, submission_number, submitted_on,
        status, status_since, notes, created_at, updated_at, created_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    randomUUID(),
    id,
    input.journalId,
    input.submissionNumber ?? null,
    input.submittedOn ?? null,
    input.status,
    input.statusSince ?? null,
    now,
    now,
    input.userId,
  );

  return id;
}

/**
 * 写一条状态变更。
 *
 * `fromStatus` 为 null 表示建档 —— 时间线的第一格没有"从哪来"。
 */
export function insertHistory(
  db: Db,
  input: {
    submissionId: string;
    fromStatus: SubmissionStatus | null;
    toStatus: SubmissionStatus;
    note: string | null;
    /** 改状态的人。建档那一格由 createSubmission 传录入者 */
    changedBy: string | null;
  },
  now: string,
): void {
  db.prepare(
    `INSERT INTO submission_history
       (id, submission_id, from_status, to_status, changed_by, changed_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.submissionId,
    input.fromStatus,
    input.toStatus,
    input.changedBy,
    now,
    input.note,
  );
}

function listHistory(db: Db, submissionId: string): SubmissionHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT id, from_status, to_status, changed_at, changed_by, note
       FROM submission_history
       WHERE submission_id = ?
       ORDER BY changed_at, rowid`,
    )
    .all(submissionId) as unknown as {
    id: string;
    from_status: string | null;
    to_status: string;
    changed_at: string;
    changed_by: string | null;
    note: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    fromStatus: r.from_status === null ? null : (r.from_status as SubmissionStatus),
    toStatus: r.to_status as SubmissionStatus,
    changedAt: r.changed_at,
    changedBy: r.changed_by,
    note: r.note,
  }));
}

/**
 * 取这本刊最新的一条分区。
 *
 * 【排序为什么是这几个键，顺序不能换】
 *   1. `year DESC` —— 先要最新年份。分区每年都变，年份是第一位的事实。
 *   2. 中科院优先 —— 实验室按中科院分区说话。两个体系都有时默认给它，
 *      但年份仍然优先于体系：宁可显示去年的中科院，也不显示三年前的 JCR。
 *   3. `category = j.field` —— v13 之后同一体系同一年**可能有多条**
 *      （大类一条、遥感小类一条）。台账一行只放得下一条，取大类那条：
 *      它正是这本刊的领域，与小类那条相比更能代表"这本刊几区"。
 *      不加这一项的话，取哪条由行在表里的物理顺序决定 ——
 *      同一份数据在两台机器上可能显示出不同的档位。
 *   4. `verified DESC` / `fetched_at DESC` —— 兜底，让结果确定。
 *
 * 只取一条、而不是把两个体系都返回：现在的界面一行只放得下一个档位。
 * 阶段 4 的管理端要并排看两个体系时再改成数组。
 */
export function loadLatestRanking(db: Db, journalId: string): JournalRanking | null {
  const row = db
    .prepare(
      `SELECT r.id, r.year, r.system, r.category, r.rank, r.top, r.note,
              r.source, r.verified, r.source_url, r.fetched_at
       FROM journal_rankings r JOIN journals j ON j.id = r.journal_id
       WHERE r.journal_id = ?
       ORDER BY r.year DESC, (r.system = '中科院') DESC,
                (r.category = j.field) DESC, r.verified DESC, r.fetched_at DESC
       LIMIT 1`,
    )
    .get(journalId) as unknown as RankingRow | undefined;

  return row === undefined ? null : toRanking(row);
}

/**
 * 按刊名或 ISSN 找一本期刊。**只查不建**。
 *
 * 与上面的 findOrCreateJournal 是两种东西，不要合并：那个是录入台账的副产品
 * （用户说"投了 Nature"，顺手把刊建出来）；这个是回答"这本刊几区"时的**查询**，
 * 查不到就该如实说"库里没收录这本刊"—— 凭空建一本空期刊，等于在库里
 * 留下一本"从来没被收录过、但看起来像已收录"的期刊，之后没人分得清。
 *
 * 刊名比较同样用 COLLATE NOCASE，与唯一索引同一口径（见 findOrCreateJournal）。
 */
export function findJournal(
  db: Db,
  query: { name?: string | undefined; issn?: string | undefined },
): Journal | null {
  const id = query.issn !== undefined && query.issn !== ''
    ? (db.prepare('SELECT id FROM journals WHERE issn = ? LIMIT 1').get(query.issn) as
        | { id: string }
        | undefined)?.id
    : undefined;

  const resolved = id ?? (query.name !== undefined && query.name !== ''
    ? (db
        .prepare('SELECT id FROM journals WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(query.name.trim()) as { id: string } | undefined)?.id
    : undefined);

  if (resolved === undefined) return null;

  const row = db
    .prepare('SELECT id, name, abbr, issn, field, website FROM journals WHERE id = ?')
    .get(resolved) as unknown as {
    id: string;
    name: string;
    abbr: string | null;
    issn: string | null;
    field: string | null;
    website: string | null;
  };
  return { id: row.id, name: row.name, abbr: row.abbr, issn: row.issn, field: row.field, website: row.website };
}

/** 按 id 取一本刊。分区库的写接口要先确认这本刊真的存在。 */
export function getJournalById(db: Db, id: string): Journal | null {
  const row = db
    .prepare('SELECT id, name, abbr, issn, field, website FROM journals WHERE id = ?')
    .get(id) as unknown as
    | {
        id: string;
        name: string;
        abbr: string | null;
        issn: string | null;
        field: string | null;
        website: string | null;
      }
    | undefined;
  return row === undefined
    ? null
    : { id: row.id, name: row.name, abbr: row.abbr, issn: row.issn, field: row.field, website: row.website };
}

/**
 * 建一本刊，或补全已有那本的缺项。**给导入与"新建期刊"接口用**。
 *
 * 【为什么不直接用 findOrCreateJournal】那个是台账录入的副产品，只认刊名、
 *   刻意不写 ISSN（录入台账时用户根本没填 ISSN 的地方）。导入种子时手里
 *   是有 ISSN 与领域的，丢掉它们等于白导一次。
 *
 * 【已有记录只补空、不覆盖】`COALESCE(issn, ?)` 的意思是"已有值优先"。
 *   覆盖已有值会让"这本刊的 ISSN 由最后一次导入决定"—— 而用户可能在
 *   分区库里手工订正过它。要改已有值走界面上的编辑，不靠一次批量导入。
 */
export function upsertJournal(
  db: Db,
  input: {
    name: string;
    abbr?: string | null;
    issn?: string | null;
    field?: string | null;
    website?: string | null;
  },
  now: string,
): { id: string; created: boolean } {
  const trimmed = input.name.trim();
  const existing = db
    .prepare('SELECT id FROM journals WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(trimmed) as unknown as { id: string } | undefined;

  if (existing !== undefined) {
    db.prepare(
      `UPDATE journals
          SET abbr = COALESCE(abbr, ?), issn = COALESCE(issn, ?),
              field = COALESCE(field, ?), website = COALESCE(website, ?)
        WHERE id = ?`,
    ).run(
      input.abbr ?? null,
      input.issn ?? null,
      input.field ?? null,
      input.website ?? null,
      existing.id,
    );
    return { id: existing.id, created: false };
  }

  const id = randomUUID();
  db.prepare(
    'INSERT INTO journals (id, name, abbr, issn, field, website, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    trimmed,
    input.abbr ?? null,
    input.issn ?? null,
    input.field ?? null,
    input.website ?? null,
    now,
  );
  return { id, created: true };
}

/**
 * 订正一本刊的 ISSN / 领域。**只改这两个字段，刊名不动**。
 *
 * 【为什么单独一个函数，而不是给 upsertJournal 加个 force 开关】
 *   那个函数的语义是"按刊名去重、只补空"，用途是导入与录入台账的副产品；
 *   这个是"用户指着某一本说之前填错了"。前者是批量、隐式，后者是单条、显式。
 *   混在一个函数里，`force` 一旦被某个调用点误传，批量导入就会开始覆盖
 *   用户订正过的值 —— 而这种事故在界面上完全看不出来。
 *
 * 返回 null = 没有这个 id 的刊（界面据此报 404，而不是假装改成功了）。
 */
export function updateJournal(
  db: Db,
  id: string,
  input: {
    /** 省略 = 不动；显式 null = 清空（与 PATCH 的三态一致）。 */
    abbr?: string | null;
    issn?: string | null;
    field?: string | null;
    website?: string | null;
  },
): Journal | null {
  const current = getJournalById(db, id);
  if (current === null) return null;
  const result = db
    .prepare('UPDATE journals SET abbr = ?, issn = ?, field = ?, website = ? WHERE id = ?')
    .run(
      input.abbr === undefined ? current.abbr : input.abbr,
      input.issn === undefined ? current.issn : input.issn,
      input.field === undefined ? current.field : input.field,
      input.website === undefined ? current.website : input.website,
      id,
    );
  if (Number(result.changes) === 0) return null;
  return getJournalById(db, id);
}

/**
 * 刊名 / ISSN 的搜索条件只写一次。
 *
 * `searchJournals`（取前 N 本）与 `countJournals`（数命中多少本）必须是
 * **同一个 where**：界面把两者一起显示成"命中 137 本，这里是前 50"，
 * 两处条件一旦有一丝出入，用户看到的就是"共 137 本"却怎么翻都翻不到 87 本。
 *
 * 转义规则与 `searchSubmissions` 同源（见 `escapeLike`）：未转义的 `%`
 * 会让"100%"匹配到任何以 100 开头的刊名。
 */
function journalSearchFilter(keyword: string | undefined): { clause: string; params: string[] } {
  if (keyword === undefined || keyword === '') return { clause: '', params: [] };
  const like = `%${escapeLike(keyword)}%`;
  return {
    clause: `WHERE (name LIKE ? ESCAPE '\\' OR abbr LIKE ? ESCAPE '\\' OR issn LIKE ? ESCAPE '\\')`,
    params: [like, like, like],
  };
}

/**
 * 库里收录了多少本刊。
 *
 * 不给关键词 = 全库总数（分区库页那句"库里共收录 N 本"）；
 * 给关键词 = **命中多少本**（界面用它判断列表有没有被 limit 截断）。
 */
export function countJournals(db: Db, keyword?: string): number {
  const { clause, params } = journalSearchFilter(keyword);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM journals ${clause}`)
    .get(...params) as unknown as { n: number };
  return row.n;
}

/**
 * 按刊名或 ISSN 搜期刊。
 *
 * 空关键词 = 列前 N 本（按刊名）。给分区库页一个"不搜也能看"的落地态 ——
 * 一进页面就是空白，用户不知道库里到底有没有东西。
 */
export function searchJournals(
  db: Db,
  query: { keyword: string | undefined; limit: number },
): Journal[] {
  const { clause, params } = journalSearchFilter(query.keyword);

  const rows = db
    .prepare(
      `SELECT id, name, abbr, issn, field, website FROM journals ${clause}
       ORDER BY name COLLATE NOCASE LIMIT ?`,
    )
    .all(...params, query.limit) as unknown as {
    id: string;
    name: string;
    abbr: string | null;
    issn: string | null;
    field: string | null;
    website: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    abbr: r.abbr,
    issn: r.issn,
    field: r.field,
    website: r.website,
  }));
}

/** 导入一条分区的三种结局。与 `RankingBackfillOutcome` 分开：
 *  那个说的是"联网回填"，这个说的是"导入/人工"。 */
export type ImportRankingOutcome =
  /** 新插了一条 */
  | 'created'
  /** 覆盖了之前那条同为导入来源的记录（值确实变了） */
  | 'updated'
  /** 值一字不差，什么都没做。重复导入时应当是这一种 */
  | 'unchanged'
  /** 本地那条是人工录入或联网来的，**没动它** */
  | 'kept_local';

/**
 * 把导入的分区写进本地表。
 *
 * 【为什么它不覆盖人工录入】导入的是权威分区表，理应能盖掉**联网抓来的**那条
 *   （若库里还留着当年的回填行），但**仍然不盖人工录入** —— 用户手工订正过的值
 *   是他对着别的依据改的，一次批量导入把它冲掉，用户看不出发生了什么。
 *   要强推走 `--force`。
 */
export function upsertImportedRanking(
  db: Db,
  input: {
    journalId: string;
    year: number;
    system: string;
    category: string;
    rank: string;
    top: boolean;
    note: string | null;
    sourceUrl: string | null;
  },
  now: string,
  options: { force?: boolean } = {},
): { ranking: JournalRanking; outcome: ImportRankingOutcome } {
  if (!Number.isInteger(input.year)) {
    throw new Error(`分区必须带年份，收到 ${String(input.year)}`);
  }

  const existing = db
    .prepare(
      `SELECT ${RANKING_COLUMNS}
       FROM journal_rankings
       WHERE journal_id = ? AND year = ? AND system = ? AND category = ?`,
    )
    .get(input.journalId, input.year, input.system, input.category) as unknown as RankingRow | undefined;

  const top = input.top ? 1 : 0;

  if (existing !== undefined) {
    if (options.force !== true && existing.source !== 'official') {
      return { ranking: toRanking(existing), outcome: 'kept_local' };
    }
    const same =
      existing.source === 'official' &&
      existing.rank === input.rank &&
      existing.top === top &&
      existing.note === input.note;
    if (same) return { ranking: toRanking(existing), outcome: 'unchanged' };

    db.prepare(
      `UPDATE journal_rankings
       SET rank = ?, top = ?, note = ?, source = 'official', source_url = ?, fetched_at = ?
       WHERE id = ?`,
    ).run(input.rank, top, input.note, input.sourceUrl, now, existing.id);

    return {
      ranking: {
        ...toRanking(existing),
        rank: input.rank,
        top: input.top,
        note: input.note,
        source: 'official',
        sourceUrl: input.sourceUrl,
        fetchedAt: now,
      },
      outcome: 'updated',
    };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO journal_rankings
       (id, journal_id, year, system, category, rank, top, note, source, verified,
        verified_by, verified_at, source_url, fetched_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'official', 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.journalId,
    input.year,
    input.system,
    input.category,
    input.rank,
    top,
    input.note,
    input.sourceUrl,
    now,
    now,
  );

  return {
    ranking: {
      id,
      year: input.year,
      system: input.system,
      category: input.category,
      rank: input.rank,
      top: input.top,
      note: input.note,
      source: 'official',
      verified: false,
      sourceUrl: input.sourceUrl,
      fetchedAt: now,
    },
    outcome: 'created',
  };
}

/**
 * 人工录入一条分区。
 *
 * 【为什么它可以覆盖导入/联网的记录】这是**用户当下明确的一次动作**：
 *   他知道自己在改什么，也有自己的依据（比如手边有一份别处的表）。
 *   与"导入批量冲掉人工值"相反，这不算无声降级 —— 是人在说话。
 *   覆盖后来源变成 manual，界面上会如实标成"人工录入"而不是冒充官方数据。
 */
export function insertManualRanking(
  db: Db,
  input: {
    journalId: string;
    year: number;
    system: string;
    category: string;
    rank: string;
    top: boolean;
    note: string | null;
    sourceUrl: string | null;
  },
  now: string,
): JournalRanking {
  if (!Number.isInteger(input.year)) {
    throw new Error(`分区必须带年份，收到 ${String(input.year)}`);
  }

  const existing = db
    .prepare(
      `SELECT ${RANKING_COLUMNS}
       FROM journal_rankings
       WHERE journal_id = ? AND year = ? AND system = ? AND category = ?`,
    )
    .get(input.journalId, input.year, input.system, input.category) as unknown as RankingRow | undefined;

  const top = input.top ? 1 : 0;

  if (existing !== undefined) {
    db.prepare(
      `UPDATE journal_rankings
       SET rank = ?, top = ?, note = ?, source = 'manual', verified = 0,
           verified_by = NULL, verified_at = NULL, source_url = ?, fetched_at = ?
       WHERE id = ?`,
    ).run(input.rank, top, input.note, input.sourceUrl, now, existing.id);
    return {
      ...toRanking(existing),
      rank: input.rank,
      top: input.top,
      note: input.note,
      source: 'manual',
      verified: false,
      sourceUrl: input.sourceUrl,
      fetchedAt: now,
    };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO journal_rankings
       (id, journal_id, year, system, category, rank, top, note, source, verified,
        verified_by, verified_at, source_url, fetched_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.journalId,
    input.year,
    input.system,
    input.category,
    input.rank,
    top,
    input.note,
    input.sourceUrl,
    now,
    now,
  );

  return {
    id,
    year: input.year,
    system: input.system,
    category: input.category,
    rank: input.rank,
    top: input.top,
    note: input.note,
    source: 'manual',
    verified: false,
    sourceUrl: input.sourceUrl,
    fetchedAt: now,
  };
}

/**
 * 删一条**人工录入**的分区。返回 false 表示没删成（不存在，或不是人工录入的）。
 *
 * 【为什么只让删人工的】导入的那份靠重新导入订正（库里本来就是那份表的副本），
 *   联网抓的靠重新抓。放开删除的话，界面上的"删除"会变成"把权威数据删掉"
 *   的按钮，而用户点的时候多半以为删的只是自己刚加错的那条。
 *   要清掉导入的数据，正确做法是改种子文件后重导，那是可复现的。
 */
export function deleteManualRanking(db: Db, journalId: string, rankingId: string): boolean {
  const result = db
    .prepare(`DELETE FROM journal_rankings WHERE id = ? AND journal_id = ? AND source = 'manual'`)
    .run(rankingId, journalId);
  return Number(result.changes) > 0;
}

/**
 * 订正人工分区的结果。三种结局的下一步完全不同，所以分开报。
 *
 * 写成**可辨识联合**而不是 `{ outcome; ranking: JournalRanking | null }`：
 * 后者会让调用方每次都得自己 `!` 一下，而"改了"与"没改成"的差别恰恰是
 * 这个接口最要紧的信息 —— 让类型系统替调用方记住它。
 */
export type UpdateRankingResult =
  /** 改成了 */
  | { outcome: 'updated'; ranking: JournalRanking }
  /** 没有这条，或者它不是人工录入的 —— 导入/联网的分区改不动 */
  | { outcome: 'not_found'; ranking: null }
  /** 改后的「年份 + 体系 + 维度」已被**另一条**占着 */
  | { outcome: 'conflict'; ranking: null };

/**
 * 订正一条**人工录入**的分区（四个字段整条替换，`id` 不变）。
 *
 * 【为什么改不动导入与联网的行】同 `deleteManualRanking`：那份数据是权威表
 *   的副本，订正的正确做法是改种子重导。放开的话，"官方分区表"就变成了
 *   界面上随手可改的一行字，而它正是用户判断"这本刊几区"的依据。
 *
 * 【为什么撞键要报冲突、而不是像新增那样盖掉对方】新增是用户**明确说**
 *   "给我记一条这个" —— 撞上已有的一条，按既有语义覆盖它。订正是用户说
 *   "把**这一条**改对"，他心里瞄准的是这一条；此时去覆盖**另一条**，
 *   他完全看不到自己刚弄丢了什么。所以宁可让他知道"那个键已经有人占了"。
 */
export function updateManualRanking(
  db: Db,
  journalId: string,
  rankingId: string,
  input: {
    year: number;
    system: string;
    category: string;
    rank: string;
    top: boolean;
    note: string | null;
    sourceUrl: string | null;
  },
  now: string,
): UpdateRankingResult {
  if (!Number.isInteger(input.year)) {
    throw new Error(`分区必须带年份，收到 ${String(input.year)}`);
  }

  const existing = db
    .prepare(
      `SELECT ${RANKING_COLUMNS}
       FROM journal_rankings
       WHERE id = ? AND journal_id = ? AND source = 'manual'`,
    )
    .get(rankingId, journalId) as unknown as RankingRow | undefined;
  if (existing === undefined) return { outcome: 'not_found', ranking: null };

  const clash = db
    .prepare(
      `SELECT id FROM journal_rankings
       WHERE journal_id = ? AND year = ? AND system = ? AND category = ? AND id <> ?
       LIMIT 1`,
    )
    .get(journalId, input.year, input.system, input.category, rankingId) as unknown as
    | { id: string }
    | undefined;
  if (clash !== undefined) return { outcome: 'conflict', ranking: null };

  const top = input.top ? 1 : 0;
  db.prepare(
    `UPDATE journal_rankings
     SET year = ?, system = ?, category = ?, rank = ?, top = ?, note = ?,
         source_url = ?, fetched_at = ?
     WHERE id = ?`,
  ).run(
    input.year,
    input.system,
    input.category,
    input.rank,
    top,
    input.note,
    input.sourceUrl,
    now,
    rankingId,
  );

  return {
    outcome: 'updated',
    ranking: {
      ...toRanking(existing),
      year: input.year,
      system: input.system,
      category: input.category,
      rank: input.rank,
      top: input.top,
      note: input.note,
      sourceUrl: input.sourceUrl,
      fetchedAt: now,
    },
  };
}

/**
 * 这本刊的全部分区记录，最新年份在前。
 *
 * 给 `query_journal` 用：与 `loadLatestRanking`（只取一条，界面一行放不下两个体系）
 * 不同，这里要**都**返回 —— 模型回答"几区"时如果只看到一条，
 * 它会以为库里只有这一条，于是把另一个体系也说成不存在。
 * 上限 20 条：分区一年一更、体系两三个，正常期刊不会有几十条。
 */
export function listRankings(db: Db, journalId: string, limit: number): JournalRanking[] {
  const rows = db
    .prepare(
      `SELECT ${RANKING_COLUMNS}
       FROM journal_rankings
       WHERE journal_id = ?
       ORDER BY year DESC, (system = '中科院') DESC, system, category, fetched_at DESC
       LIMIT ?`,
    )
    .all(journalId, limit) as unknown as RankingRow[];

  return rows.map(toRanking);
}

/**
 * 把一行组装成对外的 Submission。
 *
 * 分区与时间线各查一次（N+1）。这个规模下不值得优化：
 * 单实验室几十条台账、本地 SQLite，一次查询是微秒级；
 * 换成一条 JOIN 会得到一个"同一份台账记录被重复 N 行"的结果集，
 * 再在 JS 里拼回去 —— 代码复杂度换来的收益基本为零。
 */
function toSubmission(db: Db, row: SubmissionRow): Submission {
  const journal: Journal | null =
    row.journal_id === null
      ? null
      : {
          id: row.journal_id,
          name: row.journal_name ?? '',
          abbr: row.journal_abbr,
          issn: row.journal_issn,
          field: row.journal_field,
          website: row.journal_website,
        };

  return {
    id: row.id,
    title: row.title,
    journal,
    ranking: journal === null ? null : loadLatestRanking(db, journal.id),
    status: row.status as SubmissionStatus,
    submittedAt: row.submitted_at,
    submittedOn: row.submitted_on,
    algorithmAbbr: row.algorithm_abbr,
    submitterName: row.submitter_name,
    submitterPersonId: row.submitter_person_id,
    statusSince: row.status_since,
    currentRoundNo: row.current_round_no ?? 1,
    submissionNumber: row.submission_number,
    rounds: listSubmissionRounds(db, row.id),
    revision: row.revision,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    notes: row.notes,
    submittedById: row.user_id,
    submittedByName: row.submitted_by_name,
    history: listHistory(db, row.id),
    edits: listRecordEdits(db, 'submission', row.id),
  };
}

export interface CreateSubmissionInput {
  title: string;
  /** 未提供 = 暂不填刊名 */
  journalName: string | undefined;
  journalField: string | undefined;
  status: SubmissionStatus;
  submittedAt: string | null;
  notes: string | null;
  /** 录入者。建档那一格时间线的 changed_by 与它同源 */
  userId: string | null;
  algorithmAbbr?: string | null;
  submitterName?: string | null;
  submitterPersonId?: string | null;
  statusSince?: string | null;
  submittedOn?: string | null;
  submissionNumber?: string | null;
}

/**
 * 建一条投稿记录：找/建期刊 → 写主表 → 写时间线第一格，三件事一个事务。
 *
 * 放在这里而不是 app.ts：它是一组必须同时生效的写操作，
 * 与上面 updateSubmissionStatus 是同一种东西。app.ts 只做接线，
 * 事务边界属于数据层。
 *
 * 中途任何一步失败都整体回滚 —— 尤其是"期刊建了、投稿没写成"这种半成品：
 * 留下一本没有任何投稿记录的空期刊，用户下次录同一本刊时会以为
 * "这刊已经录过了"，而它其实只是上一次失败留下的残渣。
 */
export function createSubmission(
  db: Db,
  input: CreateSubmissionInput,
  now: string,
): { id: string; journalCreated: boolean } {
  let journalCreated = false;
  db.exec('BEGIN');
  try {
    let journalId: string | null = null;
    if (input.journalName !== undefined) {
      const journal = findOrCreateJournal(db, input.journalName, input.journalField, now);
      journalId = journal.id;
      journalCreated = journal.created;
    }

    const id = insertSubmission(
      db,
      {
        title: input.title,
        journalId,
        status: input.status,
        submittedAt: input.submittedAt,
        notes: input.notes,
        userId: input.userId,
        algorithmAbbr: input.algorithmAbbr ?? null,
        submitterName: input.submitterName ?? null,
        submitterPersonId: input.submitterPersonId ?? null,
        statusSince: input.statusSince ?? null,
        submittedOn: input.submittedOn ?? null,
        submissionNumber: input.submissionNumber ?? null,
      },
      now,
    );
    insertHistory(
      db,
      {
        submissionId: id,
        fromStatus: null,
        toStatus: input.status,
        note: null,
        changedBy: input.userId,
      },
      now,
    );

    db.exec('COMMIT');
    return { id, journalCreated };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSubmission(db: Db, id: string): Submission | null {
  const row = db
    .prepare(`SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM} WHERE s.id = ? AND s.deleted_at IS NULL`)
    .get(id) as unknown as SubmissionRow | undefined;
  return row === undefined ? null : toSubmission(db, row);
}

/** 订正主记录与当前轮次。旧轮次始终不动，状态变更仍由独立时间线接口负责。 */
export function updateSubmissionDetails(
  db: Db,
  id: string,
  patch: {
    title?: string;
    algorithmAbbr?: string | null;
    submitterName?: string | null;
    submitterPersonId?: string | null;
    journalName?: string | null;
    journalField?: string | null;
    submittedOn?: string | null;
    statusSince?: string | null;
    submissionNumber?: string | null;
    notes?: string | null;
  },
  now: string,
  actor: { userId: string; canWriteAll: boolean },
  expectedRevision?: number,
): { submission: Submission; journalCreated: boolean } | null {
  const before = getSubmission(db, id);
  if (before === null || !canWriteThisRow(db, id, actor)) return null;
  if (expectedRevision !== undefined && expectedRevision !== before.revision) {
    throw new AppError('invalid_argument', '这条投稿已被其他人更新，请刷新后重新编辑。', { httpStatus: 409 });
  }
  const latest = before.rounds.at(-1);
  if (latest === undefined) throw new Error('投稿记录缺少当前轮次，无法订正。');

  let journalCreated = false;
  db.exec('BEGIN');
  try {
    let journalId = before.journal?.id ?? null;
    if (patch.journalName !== undefined) {
      if (patch.journalName === null) {
        journalId = null;
      } else {
        const found = findOrCreateJournal(db, patch.journalName, patch.journalField ?? undefined, now);
        journalId = found.id;
        journalCreated = found.created;
      }
    }
    const title = patch.title ?? before.title;
    const algorithmAbbr = patch.algorithmAbbr === undefined ? before.algorithmAbbr : patch.algorithmAbbr;
    const submitterName = patch.submitterName === undefined ? before.submitterName : patch.submitterName;
    const submitterPersonId = patch.submitterPersonId === undefined ? before.submitterPersonId ?? null : patch.submitterPersonId;
    const submittedOn = patch.submittedOn === undefined ? latest.submittedOn : patch.submittedOn;
    const statusSince = patch.statusSince === undefined ? before.statusSince : patch.statusSince;
    const submissionNumber = patch.submissionNumber === undefined ? latest.submissionNumber : patch.submissionNumber;
    const notes = patch.notes === undefined ? before.notes : patch.notes;
    // 旧时间戳只是日期字段的回退值。明确订正日期后不能再回退显示旧日期。
    const submittedAt = patch.submittedOn === undefined ? before.submittedAt : null;

    const changed = title !== before.title || algorithmAbbr !== before.algorithmAbbr ||
      submitterName !== before.submitterName || submitterPersonId !== before.submitterPersonId || journalId !== (before.journal?.id ?? null) ||
      submittedOn !== latest.submittedOn || statusSince !== before.statusSince ||
      submissionNumber !== latest.submissionNumber || notes !== before.notes ||
      submittedAt !== before.submittedAt;
    if (changed) {
      const updated = db.prepare(
        `UPDATE submissions SET title = ?, algorithm_abbr = ?, submitter_name = ?, submitter_person_id = ?,
           journal_id = ?, submitted_at = ?, status_since = ?, notes = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).run(title, algorithmAbbr, submitterName, submitterPersonId, journalId, submittedAt, statusSince, notes, now, id, before.revision);
      if (updated.changes !== 1) {
        throw new AppError('invalid_argument', '这条投稿已被其他人更新，请刷新后重新编辑。', { httpStatus: 409 });
      }
      db.prepare(
        `UPDATE submission_rounds SET journal_id = ?, submitted_on = ?,
           status_since = ?, submission_number = ?, updated_at = ? WHERE id = ?`,
      ).run(journalId, submittedOn, statusSince, submissionNumber, now, latest.id);
      recordEdit(db, 'submission', id, {
        title: before.title,
        algorithmAbbr: before.algorithmAbbr,
        submitterName: before.submitterName,
        submitterPersonId: before.submitterPersonId ?? null,
        journalName: before.journal?.name ?? null,
        submittedOn: before.submittedOn,
        statusSince: before.statusSince,
        submissionNumber: before.submissionNumber,
        notes: before.notes,
      }, {
        title,
        algorithmAbbr,
        submitterName,
        submitterPersonId,
        journalName: patch.journalName === undefined ? before.journal?.name ?? null : patch.journalName,
        submittedOn,
        statusSince,
        submissionNumber,
        notes,
      }, actor.userId, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const submission = getSubmission(db, id);
  if (submission === null) throw new Error('投稿资料订正后无法读取。');
  return { submission, journalCreated };
}

/** 管理员删除一条误录投稿及其关联数据，并保留最小操作审计。 */
/**
 * 按 id 取一条**并且**检查当前用户看不看得见它。
 *
 * 【为什么不给 getSubmission 加 scope 参数】它在 repo 内部还被
 *   `createSubmission` / `updateSubmissionStatus` 用着 —— 那两处的调用
 *   发生在"刚写完、正要读回自己那条"的语境里，与可见性无关。
 *   让内部调用也去查可见性，只会多出"为什么我刚建的记录读不出来"这类怪事。
 *
 * 【看不见时返回 null（→ 404），而不是抛 403】
 *   403 等于确认"这条记录存在，只是你不能看"。记录的存在性本身
 *   （"某某投了某某刊"）就是信息。所以不可见与不存在对外必须长得一模一样。
 */
export function getSubmissionFor(db: Db, id: string, scope: RowScope): Submission | null {
  const { sql: visible, params } = scopePredicate('s.user_id', scope);
  const row = db
    .prepare(`SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM} WHERE s.id = ? AND s.deleted_at IS NULL AND ${visible}`)
    .get(id, ...params) as unknown as SubmissionRow | undefined;
  return row === undefined ? null : toSubmission(db, row);
}

/**
 * 台账列表。按最近更新倒序 —— 最近动过的排最上面。
 *
 * 可见性**在 WHERE 里**过滤（见 auth/scope.ts 顶部）：
 * 先查再筛会让 LIMIT 的语义变形（"限 200 条"变成"限 200 条之后剩下的"）。
 */
export function listSubmissions(db: Db, limit: number, scope: RowScope): Submission[] {
  const { sql: visible, params } = scopePredicate('s.user_id', scope);
  const rows = db
    .prepare(
      `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM}
        WHERE s.deleted_at IS NULL AND ${visible} ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as SubmissionRow[];
  return rows.map((row) => toSubmission(db, row));
}

/**
 * 某个人登记的投稿（首页「我的投稿」用）。
 *
 * 【为什么不用 scopePredicate】台账页问的是"我能看到哪些"（含公共历史数据、
 *   导师含全组），而首页问的是"我做过什么"。后者必须是严格的 `user_id = 我`，
 *   否则首页会把阶段 1–3 无主的历史投稿也算成"我登记的"。两个问题共用谓词
 *   必然有一边是错的。
 */
export function listSubmissionsByUser(db: Db, userId: string, limit: number): Submission[] {
  const rows = db
    .prepare(
      `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM}
        WHERE s.deleted_at IS NULL AND s.user_id = ? ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(userId, limit) as unknown as SubmissionRow[];
  return rows.map((row) => toSubmission(db, row));
}

/**
 * LIKE 的转义。
 *
 * 【为什么必须转义】问"投了 100% 的那篇"时，未转义的 `%` 会变成"任意字符"，
 * 于是 `100%` 匹配到任何以 `100` 开头的东西 —— 召回一堆不相关记录，
 * 而模型会把它们当成"台账里的原话"写进回答。`_` 同理（匹配任意一个字符）。
 * `\` 自己也要转义，否则以 `\` 结尾的搜索词会把后面的 ESCAPE 吃掉。
 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 按关键词 / 状态查台账。给 `query_submissions` 工具用。
 *
 * 关键词同时匹配**标题**与**期刊名**：用户问"我投的 Nature 那篇"时，
 * 他可能只记得刊名，也可能只记得标题里的几个字，两边都试一次才够用。
 *
 * 仍然按 `updated_at DESC`：命中的多条里，最近动过的多半是他要找的那条。
 */
interface SubmissionSearch {
  keyword: string | undefined;
  status: SubmissionStatus | undefined;
  scope: RowScope;
  personId?: string;
  groupId?: string;
  year?: number;
}

function submissionSearchWhere(query: SubmissionSearch) {
  const where = ['s.deleted_at IS NULL'];
  const params: (string | number | null)[] = [];

  const visible = scopePredicate('s.user_id', query.scope);
  where.push(visible.sql);
  params.push(...visible.params);

  if (query.keyword !== undefined && query.keyword !== '') {
    const like = `%${escapeLike(query.keyword)}%`;
    where.push(
      `(s.title LIKE ? ESCAPE '\\' OR s.algorithm_abbr LIKE ? ESCAPE '\\'
        OR s.submitter_name LIKE ? ESCAPE '\\' OR pe.name LIKE ? ESCAPE '\\'
        OR j.name LIKE ? ESCAPE '\\' OR j.abbr LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM submission_rounds r
                    WHERE r.submission_id = s.id
                      AND r.submission_number LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like, like, like, like, like, like);
  }
  if (query.status !== undefined) {
    where.push('s.status = ?');
    params.push(query.status);
  }
  if (query.personId !== undefined) { where.push('s.submitter_person_id = ?'); params.push(query.personId); }
  if (query.groupId !== undefined) { where.push('pe.group_id = ?'); params.push(query.groupId); }
  if (query.year !== undefined) {
    const date = query.status === undefined
      ? 'COALESCE((SELECT r.submitted_on FROM submission_rounds r WHERE r.submission_id = s.id ORDER BY r.round_no DESC LIMIT 1), s.submitted_at)'
      : 's.status_since';
    where.push(`substr(${date}, 1, 4) = ?`);
    params.push(String(query.year));
  }

  return { clause: `WHERE ${where.join(' AND ')}`, params };
}

export function countMatchingSubmissions(db: Db, query: SubmissionSearch): number {
  const { clause, params } = submissionSearchWhere(query);
  return (db.prepare(`SELECT COUNT(*) AS n ${SUBMISSION_FROM} ${clause}`)
    .get(...params) as { n: number }).n;
}

export function searchSubmissions(
  db: Db,
  query: SubmissionSearch & { limit: number; offset?: number },
): Submission[] {
  const { clause, params } = submissionSearchWhere(query);
  const rows = db
    .prepare(
      `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM} ${clause} ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset ?? 0) as unknown as SubmissionRow[];
  return rows.map((row) => toSubmission(db, row));
}

/**
 * 改状态：更新主表 + 写一条时间线，两件事必须在**同一个事务**里。
 *
 * 只改状态不写历史 → 时间线缺一格，而且缺在中间，回看时对不上；
 * 只写历史不改状态 → 列表显示的状态和最新一条历史矛盾。
 * 任何一种都比"这次操作整体失败"更难收拾。
 *
 * 返回 null 表示这条记录不存在（由调用方转成 404）。
 */
export function updateSubmissionStatus(
  db: Db,
  id: string,
  nextStatus: SubmissionStatus,
  statusSince: string | null,
  note: string | null,
  now: string,
  actor: { userId: string; canWriteAll: boolean },
): Submission | null {
  const before = getSubmission(db, id);
  if (before === null) return null;

  if (!canWriteThisRow(db, id, actor)) return null;

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE submissions SET status = ?, status_since = ?, updated_at = ? WHERE id = ?').run(
      nextStatus,
      statusSince,
      now,
      id,
    );
    // 当前轮次与主表同步。status_since 是“实际进入该状态的日期”，
    // updated_at 仍是写入时刻 —— 两者不能互相冒充。
    db.prepare(
      `UPDATE submission_rounds SET status = ?, status_since = ?, updated_at = ?
       WHERE submission_id = ?
         AND round_no = (SELECT MAX(round_no) FROM submission_rounds WHERE submission_id = ?)`,
    ).run(nextStatus, statusSince, now, id, id);
    insertHistory(
      db,
      {
        submissionId: id,
        fromStatus: before.status,
        toStatus: nextStatus,
        note,
        changedBy: actor.userId,
      },
      now,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getSubmission(db, id);
}

interface RoundRow {
  id: string;
  submission_id: string;
  round_no: number;
  submission_number: string | null;
  submitted_on: string | null;
  status: string;
  status_since: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  journal_id: string | null;
  journal_name: string | null;
  journal_abbr: string | null;
  journal_issn: string | null;
  journal_field: string | null;
  journal_website: string | null;
}

const ROUND_COLUMNS = `r.id, r.submission_id, r.round_no, r.submission_number,
  r.submitted_on, r.status, r.status_since, r.notes, r.created_at, r.updated_at,
  j.id AS journal_id, j.name AS journal_name, j.abbr AS journal_abbr,
  j.issn AS journal_issn, j.field AS journal_field, j.website AS journal_website`;

const ROUND_FROM = `FROM submission_rounds r
  LEFT JOIN journals j ON j.id = r.journal_id`;

function toRound(row: RoundRow): SubmissionRound {
  return {
    id: row.id,
    submissionId: row.submission_id,
    roundNo: row.round_no,
    journal:
      row.journal_id === null
        ? null
        : {
            id: row.journal_id,
            name: row.journal_name ?? '',
            abbr: row.journal_abbr,
            issn: row.journal_issn,
            field: row.journal_field,
            website: row.journal_website,
          },
    submissionNumber: row.submission_number,
    submittedOn: row.submitted_on,
    status: row.status as SubmissionStatus,
    statusSince: row.status_since,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 一篇稿件的全部投稿轮次，按轮次升序。 */
export function listSubmissionRounds(db: Db, submissionId: string): SubmissionRound[] {
  const rows = db
    .prepare(`SELECT ${ROUND_COLUMNS} ${ROUND_FROM}
              WHERE r.submission_id = ? ORDER BY r.round_no ASC`)
    .all(submissionId) as unknown as RoundRow[];
  return rows.map(toRound);
}

export interface CreateRoundInput {
  journalName: string | undefined;
  journalField: string | undefined;
  submittedOn: string | null;
  status: SubmissionStatus;
  statusSince: string | null;
  submissionNumber: string | null;
  notes: string | null;
  userId: string | null;
}

/**
 * 在同一篇稿件上新增一轮投稿（拒稿后转投）。
 *
 * 只新增轮次、更新主表的“当前指针”（journal_id / status / status_since），
 * 不动任何历史轮次。状态没变时不再写时间线 —— 时间线记的是状态变化，
 * 转投这件事本身由轮次列表表达。
 */
export function createSubmissionRound(
  db: Db,
  submissionId: string,
  input: CreateRoundInput,
  now: string,
): { round: SubmissionRound; journalCreated: boolean } {
  let journalCreated = false;
  db.exec('BEGIN');
  try {
    const before = getSubmission(db, submissionId);
    if (before === null) throw new Error('submission not found');

    let journalId: string | null = null;
    if (input.journalName !== undefined) {
      const journal = findOrCreateJournal(db, input.journalName, input.journalField, now);
      journalId = journal.id;
      journalCreated = journal.created;
    }

    const maxRow = db
      .prepare('SELECT MAX(round_no) AS n FROM submission_rounds WHERE submission_id = ?')
      .get(submissionId) as unknown as { n: number | null };
    const roundNo = (maxRow.n ?? 0) + 1;

    const roundId = randomUUID();
    db.prepare(
      `INSERT INTO submission_rounds
         (id, submission_id, round_no, journal_id, submission_number, submitted_on,
          status, status_since, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      roundId,
      submissionId,
      roundNo,
      journalId,
      input.submissionNumber,
      input.submittedOn,
      input.status,
      input.statusSince,
      input.notes,
      now,
      now,
      input.userId,
    );

    db.prepare(
      'UPDATE submissions SET journal_id = ?, status = ?, status_since = ?, updated_at = ? WHERE id = ?',
    ).run(journalId, input.status, input.statusSince, now, submissionId);

    if (before.status !== input.status) {
      insertHistory(
        db,
        {
          submissionId,
          fromStatus: before.status,
          toStatus: input.status,
          note: input.notes,
          changedBy: input.userId,
        },
        now,
      );
    }

    db.exec('COMMIT');

    const row = db
      .prepare(`SELECT ${ROUND_COLUMNS} ${ROUND_FROM} WHERE r.id = ?`)
      .get(roundId) as unknown as RoundRow;
    return { round: toRound(row), journalCreated };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 这条记录这个人改不改得动。
 *
 * 判据是 `user_id = 我`（或持有 `submission.write.all`）。**归属为 NULL 的
 * 历史记录，除 write.all 之外谁都不能改。**
 *
 * 【为什么 NULL 不给"谁都能改"】读的时候 NULL = 公共数据是对的 ——
 *   "谁都能看见"不会改变任何东西。写不一样：改状态就是往时间线里留下一格
 *   "谁在什么时候把这条改成了什么"，而 NULL 行没有"谁"。让任何成员都能改，
 *   等于让台账里那几条最早的记录变成人人都能改写的东西，而时间线里
 *   记下的 changed_by 也不是当初那个人。宁可让它们只有管理员能碰。
 */
function canWriteThisRow(
  db: Db,
  id: string,
  actor: { userId: string; canWriteAll: boolean },
): boolean {
  if (actor.canWriteAll) return true;
  const row = db.prepare('SELECT user_id FROM submissions WHERE id = ?').get(id) as unknown as
    | { user_id: string | null }
    | undefined;
  return row !== undefined && row.user_id !== null && row.user_id === actor.userId;
}
