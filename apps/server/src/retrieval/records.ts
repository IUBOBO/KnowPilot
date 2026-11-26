import { createHash } from 'node:crypto';
import {
  hasPermission, PATENT_FILTER_LABELS, PERSON_STATUS_LABELS, SUBMISSION_STATUS_LABELS, isUnverifiedSource,
  type AuthUser, type CitationField, type Patent, type PatentFilter, type Person, type PersonStatus,
  type RecordType, type Submission, type SubmissionStatus, type Thesis,
} from '@knowpilot/shared';
import { submissionScope, type RowScope } from '../auth/scope.ts';
import type { Db } from '../db/index.ts';
import { getPatentFor, listPatentPage, type PatentScope } from '../patents/repo.ts';
import { getPerson, listPeople } from '../people/repo.ts';
import { countMatchingSubmissions, getSubmissionFor, searchSubmissions } from '../submissions/repo.ts';
import { getThesis, listTheses, type ThesisViewer } from '../theses/repo.ts';

export interface RecordEvidenceInput {
  recordType: RecordType;
  recordId: string;
  recordTitle: string;
  queryTime: string;
  recordUpdatedAt: string | null;
  version?: string;
  fields: readonly CitationField[];
}

export function recordSourceVersion(record: RecordEvidenceInput): string {
  return record.version ?? record.recordUpdatedAt ?? record.queryTime;
}

export function recordDependsOnLinkedFields(type: RecordType): boolean {
  return type === 'M-SUBMIT' || type === 'M-PATENT' || type === 'M-THESIS';
}

/** Bind visible fields when evidence also depends on linked metadata. */
export function recordContentFingerprint(title: string, fields: readonly CitationField[]): string {
  return createHash('sha256').update(JSON.stringify([title, fields.map(({ label, value }) => [label, value])])).digest('hex');
}

export function renderRecordBody(fields: readonly CitationField[]): string {
  return fields.map((f) => `${f.label}：${f.value}`).join('\n');
}

type LedgerQuery = {
  keyword: string | undefined;
  limit: number;
  offset: number;
  recordId?: string;
  personId?: string;
  groupId?: string;
  year?: number;
} & (
  | { type: 'M-SUBMIT'; status: SubmissionStatus | undefined }
  | { type: 'M-PERSON'; status?: PersonStatus }
  | { type: 'M-PATENT'; filter: PatentFilter; registrant?: string }
  | { type: 'M-THESIS' }
);

interface LedgerViewer {
  user?: AuthUser;
  /** CLI / Agent 调用已通过 submissionScope 推导出的范围。 */
  submission?: RowScope;
}

interface LedgerCandidates {
  records: readonly RecordEvidenceInput[];
  matched: number;
}

function one(record: RecordEvidenceInput | null): LedgerCandidates {
  return record === null ? { records: [], matched: 0 } : { records: [record], matched: 1 };
}

/** 使用各权威台账的可见范围和 SQL 筛选；队列入池、预算和渲染仍由 Agent 管理。 */
export function queryLedger(db: Db, query: LedgerQuery, viewer: LedgerViewer, queryTime: string): LedgerCandidates {
  const { recordId, limit, offset, keyword, personId, groupId, year } = query;
  // Exact ID resolution uses the original scope and ignores free-text and list filters.
  if (recordId !== undefined && offset !== 0) return one(null);
  const linked = { ...(personId === undefined ? {} : { personId }), ...(groupId === undefined ? {} : { groupId }) };

  if (query.type === 'M-SUBMIT') {
    const scope = viewer.submission ?? submissionScope(viewer.user ?? null);
    if (recordId !== undefined) {
      const found = getSubmissionFor(db, recordId, scope);
      return one(found === null ? null : submissionEvidence(found, queryTime));
    }
    const search = { keyword: keyword?.trim(), status: query.status, scope, ...linked, ...(year === undefined ? {} : { year }) };
    return {
      records: searchSubmissions(db, { ...search, limit, offset }).map((row) => submissionEvidence(row, queryTime)),
      matched: countMatchingSubmissions(db, search),
    };
  }

  const user = viewer.user;
  if (user === undefined) return one(null);
  if (query.type === 'M-PERSON') {
    if (!hasPermission(user.role, 'people.read')) return one(null);
    const scope = { userId: user.id, canReadSensitive: false, canManage: false };
    if (recordId !== undefined) {
      const found = getPerson(db, recordId, scope);
      return one(found === null ? null : personEvidence(found, queryTime));
    }
    const result = listPeople(db, { keyword, limit, offset, ...linked, ...(query.status ? { status: query.status } : {}) }, scope);
    return { records: result.items.map((row) => personEvidence(row, queryTime)), matched: result.matched };
  }

  if (query.type === 'M-PATENT') {
    const scope = patentView(user);
    if (!scope.canReadAll && !hasPermission(user.role, 'patent.read.own')) return one(null);
    if (recordId !== undefined) {
      const found = getPatentFor(db, recordId, scope);
      return one(found === null ? null : patentEvidence(found, queryTime));
    }
    const result = listPatentPage(db, {
      keyword: keyword?.trim(), limit, offset, ...linked, filter: query.filter,
      ...(query.registrant === undefined ? {} : { registrant: query.registrant }),
      ...(year === undefined ? {} : { year }),
    }, scope);
    return { records: result.items.map((row) => patentEvidence(row, queryTime)), matched: result.matched };
  }

  if (!hasPermission(user.role, 'thesis.read')) return one(null);
  const scope = thesisView(user);
  if (recordId !== undefined) {
    const found = getThesis(db, recordId, scope);
    return one(found === null ? null : thesisEvidence(found, queryTime));
  }
  const result = listTheses(db, { keyword: keyword?.trim(), limit, offset, ...linked }, scope);
  return { records: result.items.map((row) => thesisEvidence(row, queryTime)), matched: result.matched };
}

export function restoreLedgerEvidence(
  db: Db, user: AuthUser, type: 'M-PATENT' | 'M-THESIS' | 'M-PERSON', id: string, queryTime: string,
): RecordEvidenceInput | null {
  const input = { keyword: undefined, limit: 1, offset: 0, recordId: id };
  const query = type === 'M-PATENT' ? { ...input, type, filter: 'all' as const } : { ...input, type };
  return queryLedger(db, query, { user }, queryTime).records[0] ?? null;
}

function submissionEvidence(submission: Submission, queryTime: string): RecordEvidenceInput {
  return {
    recordType: 'M-SUBMIT', recordId: submission.id, recordTitle: submission.title, queryTime,
    recordUpdatedAt: submission.updatedAt, fields: submissionFields(submission),
  };
}

function patentEvidence(patent: Patent, queryTime: string): RecordEvidenceInput {
  const fields: CitationField[] = [{ label: '专利名称', value: patent.name }];
  if (patent.createdByName) fields.push({ label: '登记人', value: patent.createdByName });
  const applicant = patent.applicantName ?? patent.applicantPersonName;
  if (applicant) fields.push({ label: '申请人', value: applicant });
  if (patent.patentNo) fields.push({ label: '专利号', value: patent.patentNo });
  if (patent.firstSubmittedOn) fields.push({ label: '申请日期', value: patent.firstSubmittedOn });
  if (patent.substantiveExamOn) fields.push({ label: '实审日期', value: patent.substantiveExamOn });
  if (patent.publishedOn) fields.push({ label: '公布日期', value: patent.publishedOn });
  if (patent.grantedOn) fields.push({ label: '授权日期', value: patent.grantedOn });
  fields.push({ label: '台账状态', value: patent.grantedOn ? PATENT_FILTER_LABELS.granted
    : patent.publishedOn ? PATENT_FILTER_LABELS.published
      : patent.substantiveExamOn ? PATENT_FILTER_LABELS.under_review : patent.firstSubmittedOn ? '已提交申请' : '日期待核实' });
  if (patent.notes) fields.push({ label: '备注', value: patent.notes });
  return { recordType: 'M-PATENT', recordId: patent.id, recordTitle: patent.name, queryTime, recordUpdatedAt: patent.updatedAt, fields };
}

function thesisEvidence(thesis: Thesis, queryTime: string): RecordEvidenceInput {
  const author = thesis.personName ?? thesis.authorName;
  const title = thesis.title ?? `${author}的大论文`;
  const fields: CitationField[] = [{ label: '大论文题目', value: thesis.title ?? '题目未填' }];
  if (author) fields.push({ label: '作者', value: author });
  if (thesis.direction) fields.push({ label: '研究方向', value: thesis.direction });
  if (thesis.gradeVisible && thesis.grade) fields.push({ label: '成绩', value: thesis.grade });
  if (thesis.notes) fields.push({ label: '备注', value: thesis.notes });
  return { recordType: 'M-THESIS', recordId: thesis.id, recordTitle: title, queryTime, recordUpdatedAt: thesis.updatedAt, fields };
}

function patentView(user: AuthUser): PatentScope {
  return { userId: user.id, canReadAll: hasPermission(user.role, 'patent.read.all') };
}

function thesisView(user: AuthUser): ThesisViewer {
  return { userId: user.id, canReadGrade: hasPermission(user.role, 'thesis.read.grade') };
}

function personEvidence(person: Person, queryTime: string): RecordEvidenceInput {
  const fields = [{ label: '姓名', value: person.name }, { label: '人员状态', value: PERSON_STATUS_LABELS[person.status] }];
  if (person.groupId) fields.push({ label: '课题组', value: person.groupId });
  return { recordType: 'M-PERSON', recordId: person.id, recordTitle: person.name, queryTime, recordUpdatedAt: person.updatedAt, fields };
}

export function submissionFields(s: Submission): CitationField[] {
  const fields: CitationField[] = [{ label: '状态', value: SUBMISSION_STATUS_LABELS[s.status] }];

  if (s.journal !== null) fields.push({ label: '期刊', value: s.journal.name });

  // 分区连同**年份与维度**一起给，不能只给档位：分区一年一更，"1区"单独出现
  // 无法判断是哪一年的（04 号 §4 的分区表硬约束）；而同一本刊的大类分区与
  // 小类分区可以不同，不说维度也会变成另一件事。
  // 「未经核对」看**来源**、不看 verified —— 官方分区表导进来的那条 verified
  // 也是 0，按 verified 判断会给权威数据打上"未经核对"，那是句假话。
  if (s.ranking !== null) {
    const cat = s.ranking.category === '' ? '' : `（${s.ranking.category}）`;
    const top = s.ranking.top ? ' Top' : '';
    const unverified = isUnverifiedSource(s.ranking.source) ? '（未经核对）' : '';
    fields.push({
      label: '分区',
      value: `${s.ranking.system} ${s.ranking.year} 年${cat} ${s.ranking.rank}${top}${unverified}`,
    });
  }

  if (s.algorithmAbbr !== null && s.algorithmAbbr !== '') {
    fields.push({ label: '稿件简称', value: s.algorithmAbbr });
  }
  if (s.submitterName !== null && s.submitterName !== '') {
    fields.push({ label: '投稿人', value: s.submitterName });
  }
  fields.push({ label: '投稿日期', value: s.submittedOn ?? s.submittedAt ?? '未投出（准备中）' });
  fields.push({ label: '投稿轮次', value: `第 ${s.currentRoundNo} 次` });
  if (s.submissionNumber !== null && s.submissionNumber !== '') {
    fields.push({ label: '投稿号', value: s.submissionNumber });
  }
  if (s.statusSince !== null) {
    fields.push({ label: '进入当前状态日期', value: s.statusSince });
  }
  fields.push({ label: '最近更新', value: s.updatedAt });
  if (s.notes !== null && s.notes !== '') fields.push({ label: '备注', value: s.notes });

  return fields;
}
