/**
 * 种子导入的实际动作。CLI（`seed-cli.ts`）与验证脚本（`journal-check.ts`）
 * 共用这一份 —— 验证脚本要是自己另抄一遍循环，那它测的就只是"另抄的那份对不对"，
 * 而真正跑在部署脚本里的那个循环一行都没被覆盖过。
 *
 */
import { readFileSync } from 'node:fs';
import type { Db } from '../../db/index.ts';
import { upsertImportedRanking, upsertJournal, type ImportRankingOutcome } from '../repo.ts';

export interface SeedRanking {
  system: string;
  category: string;
  rank: string;
  top: boolean;
  note: string | null;
}

export interface SeedJournal {
  name: string;
  issn: string | null;
  field: string | null;
  rankings: SeedRanking[];
}

export interface SeedFile {
  meta: {
    dataset: string;
    filter: string;
    source: string;
    sourceUrl: string;
    year: number;
    jcrMissing?: number;
    generatedAt: string;
  };
  journals: SeedJournal[];
}

export function readSeedFile(file: string | URL): SeedFile {
  return JSON.parse(readFileSync(file, 'utf8')) as SeedFile;
}

export interface ImportSummary {
  journalsCreated: number;
  journalsReused: number;
  totalRankings: number;
  outcomes: Record<ImportRankingOutcome, number>;
}

/**
 * 把种子写进库。**幂等**：同一份种子跑多少遍结果都一样。
 *
 * 全部写操作包在一个事务里。两千多条语句逐条提交时，SQLite 每条都要 fsync，
 * 在机械盘上能跑出一分钟去；而且中途出错会留下一个"导到一半"的库 ——
 * 那比没导更糟，用户看不出哪些刊有分区、哪些没有。
 */
export function importSeed(
  db: Db,
  seed: SeedFile,
  now: string,
  options: { force?: boolean } = {},
): ImportSummary {
  const outcomes: Record<ImportRankingOutcome, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    kept_local: 0,
  };
  let journalsCreated = 0;
  let totalRankings = 0;

  db.exec('BEGIN');
  try {
    for (const j of seed.journals) {
      const { id, created } = upsertJournal(db, { name: j.name, issn: j.issn, field: j.field }, now);
      if (created) journalsCreated += 1;

      for (const r of j.rankings) {
        totalRankings += 1;
        const { outcome } = upsertImportedRanking(
          db,
          {
            journalId: id,
            year: seed.meta.year,
            system: r.system,
            category: r.category,
            rank: r.rank,
            top: r.top,
            note: r.note,
            sourceUrl: seed.meta.sourceUrl,
          },
          now,
          options,
        );
        outcomes[outcome] += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    journalsCreated,
    journalsReused: seed.journals.length - journalsCreated,
    totalRankings,
    outcomes,
  };
}
