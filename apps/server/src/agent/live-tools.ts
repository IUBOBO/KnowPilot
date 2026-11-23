/**
 * 两个**实时查询**工具：查投稿台账（C-DB / M-SUBMIT）与查数据集位置（C-FS / M-CODE）。
 *
 * 【为什么它们是两个专用工具，而不是一个"万能查询"工具】
 *   02 号 §3 的 Tool 一行明写：❌ 不让一个"万能查询工具"掩盖需要治理的流程。
 *   一个收 SQL 的工具看起来更省事，代价是：模型能查的表、能拼的条件再也不受控，
 *   而"哪些数据可以给模型看"正是阶段 4 权限要管的事。两个专用工具的入参
 *   只有一个关键词和几个白名单枚举，服务层能一眼看清它到底能碰到什么。
 *
 * 【为什么工具名是 query_submissions / probe_dataset，不是 C-DB / C-FS】
 *   能力代号（C-*）是设计文档里描述"有哪几类外部能力"的标识；工具名是给模型看的。
 *   给模型一个叫 `C-DB` 的工具，它只会以为那是个通用数据库入口。
 *
 * 【两个工具的共同点：返回的记录由服务端从库里现取，模型碰不到】
 *   与文档引用同一个口径 —— 模型只能拿到证据号 [En]，台账里的状态、路径、
 *   存在性全部由服务端填。所以台账类引用**不可能**被编造：
 *   模型能犯的错只剩"引一个没发过的编号"，那是纯字符串比对就能拦住的。
 */
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  ASSET_CHECK_LABELS,
  DATASET_PROFILE_LABELS,
  PATENT_FILTER_LABELS,
  PERSON_STATUSES,
  PERSON_STATUS_LABELS,
  SUBMISSION_STATUSES,
  SUBMISSION_STATUS_LABELS,
  isUnverifiedSource,
  type CitationField,
  type CodeAsset,
  type AuthUser,
  type Patent,
  type Person,
  type Submission,
  type Thesis,
  hasPermission,
} from '@knowpilot/shared';
import type { RowScope } from '../auth/scope.ts';
import { checkAsset, probeRoots, type AssetProbe } from '../code/check.ts';
import { countMatchingCodeAssets, searchCodeAssets } from '../code/repo.ts';
import type { Db } from '../db/index.ts';
import { getPatentFor, listPatentPage, type PatentScope } from '../patents/repo.ts';
import { getPerson, listPeople } from '../people/repo.ts';
import { getDocumentFile } from '../documents/repo.ts';
import { countMatchingSubmissions, getSubmissionFor, searchSubmissions } from '../submissions/repo.ts';
import { getThesis, listTheses, type ThesisViewer } from '../theses/repo.ts';
import {
  renderEvidenceForModel,
  type EvidencePool,
  type QueryDetails,
  type RecordEvidenceInput,
} from './evidence.ts';

export const SUBMISSIONS_TOOL = 'query_submissions';
export const DATASET_TOOL = 'probe_dataset';
export const PATENTS_TOOL = 'query_patents';
export const THESES_TOOL = 'query_theses';
export const PEOPLE_TOOL = 'query_people';

/** 默认返回条数。给模型的不宜多：台账与数据集都是几条到几十条的规模。 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

const PageParams = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: '每页条数，默认 5。' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: '从第几条开始，第一批用 0，然后按工具返回的下一页起点查询。' })),
};
const LinkedPersonParams = {
  person_id: Type.Optional(Type.String({ description: '人员查询返回的记录 ID，仅匹配明确关联。' })),
  group_id: Type.Optional(Type.String({ description: '关联人员在主档中的课题组。' })),
};
const YearParam = Type.Optional(Type.Integer({ minimum: 1900, maximum: 2999 }));

function linkedPerson(params: { person_id?: string; group_id?: string }) {
  return {
    ...(params.person_id ? { personId: params.person_id } : {}),
    ...(params.group_id ? { groupId: params.group_id } : {}),
  };
}

const SubmissionsParams = Type.Object({
  record_id: Type.Optional(Type.String({ description: '此前查询返回的稿件记录 ID。' })),
  keyword: Type.Optional(
    Type.String({
      description:
        '投稿人姓名、题名、期刊名、稿件简称或投稿号中的一段文字。只填关键词，问有哪些人时省略关键词。',
    }),
  ),
  // 用 StringEnum 而非 Type.Union(Type.Literal(...))：后者在收到 `.map()` 出来的
  // 数组时元组推断失败，`Static` 会退化成 `never`（见 tools.ts 里的同一处说明）。
  status: Type.Optional(
    StringEnum(SUBMISSION_STATUSES, { description: '按稿件状态过滤。只在用户明确说了状态时使用。' }),
  ),
  year: YearParam,
  ...LinkedPersonParams,
  ...PageParams,
});

const PatentParams = Type.Object({
  keyword: Type.Optional(Type.String({ description: '专利名称或专利号的关键词。查询有哪些登记人时省略。' })),
  registrant: Type.Optional(Type.String({ description: '只按实际登记人的姓名查询。' })),
  record_id: Type.Optional(Type.String({ description: '此前查询返回的专利记录 ID，用于核对某一条。' })),
  milestone: Type.Optional(StringEnum(['under_review', 'published', 'granted'] as const,
    { description: '分别筛选实审中、曾公开、明确登记授权。' })),
  year: YearParam,
  ...LinkedPersonParams,
  ...PageParams,
});

const ThesisParams = Type.Object({
  keyword: Type.Optional(Type.String({ description: '作者、题名或研究方向关键词。需要寻找相似方向时，用已查到的方向词另查一页。' })),
  record_id: Type.Optional(Type.String({ description: '此前查询返回的大论文记录 ID，用于核对某一条。' })),
  ...LinkedPersonParams,
  ...PageParams,
});

const PeopleParams = Type.Object({
  keyword: Type.Optional(Type.String({ description: '学生姓名；查名单时省略。' })),
  record_id: Type.Optional(Type.String({ description: '已有人员记录 ID。' })),
  group_id: Type.Optional(Type.String({ description: '人员主档中登记的课题组。' })),
  status: Type.Optional(StringEnum(PERSON_STATUSES, { description: '在组、毕业或离组。按明确要求使用。' })),
  ...PageParams,
});

function recordPage(pool: EvidencePool, records: readonly RecordEvidenceInput[], matched: number, offset: number): AgentToolResult<QueryDetails> {
  const evidenceIds: string[] = [];
  const newEvidenceIds: string[] = [];
  const rendered = records.map((record) => {
    const { evidence, isNew } = pool.addRecord(record);
    evidenceIds.push(evidence.id);
    if (isNew) newEvidenceIds.push(evidence.id);
    return renderEvidenceForModel(evidence);
  });
  const next = offset + records.length;
  return {
    content: [{ type: 'text', text: [
      `当前可查询范围内匹配 ${matched} 条记录，本页返回 ${records.length} 条。`,
      records.length > 0 && next < matched ? `还有下一页，使用 offset=${next}。` : '',
      ...rendered,
    ].filter(Boolean).join('\n\n') }],
    details: { evidenceIds, newEvidenceIds, matchedCount: matched },
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

export function restoreLedgerEvidence(db: Db, user: AuthUser, type: 'M-PATENT' | 'M-THESIS' | 'M-PERSON', id: string, queryTime: string): RecordEvidenceInput | null {
  if (type === 'M-PERSON') {
    if (!hasPermission(user.role, 'people.read')) return null;
    const person = getPerson(db, id, { userId: user.id, canReadSensitive: false, canManage: false });
    return person ? personEvidence(person, queryTime) : null;
  }
  if (type === 'M-PATENT') {
    const patent = getPatentFor(db, id, patentView(user));
    return patent === null ? null : patentEvidence(patent, queryTime);
  }
  if (!hasPermission(user.role, 'thesis.read')) return null;
  const thesis = getThesis(db, id, thesisView(user));
  return thesis === null ? null : thesisEvidence(thesis, queryTime);
}

export function createPeopleTool(db: Db, pool: EvidencePool, user: AuthUser): AgentTool<typeof PeopleParams, QueryDetails> {
  return {
    name: PEOPLE_TOOL,
    label: '查人员档案',
    description: '按姓名、课题组和登记状态查学生名单。用于确认人员身份、区分同名，或提供人员 ID 以核对关联成果。',
    parameters: PeopleParams,
    execute: async (_id, params) => {
      if (!hasPermission(user.role, 'people.read')) return recordPage(pool, [], 0, 0);
      const time = new Date().toISOString();
      if (params.record_id !== undefined) {
        const hit = restoreLedgerEvidence(db, user, 'M-PERSON', params.record_id, time);
        return recordPage(pool, hit === null ? [] : [hit], hit === null ? 0 : 1, 0);
      }
      const offset = params.offset ?? 0;
      const page = listPeople(db, { keyword: params.keyword, offset, limit: params.limit ?? DEFAULT_LIMIT,
        ...(params.group_id ? { groupId: params.group_id } : {}), ...(params.status ? { status: params.status } : {}),
      }, { userId: user.id, canReadSensitive: false, canManage: false });
      return recordPage(pool, page.items.map((person) => personEvidence(person, time)), page.matched, offset);
    },
  };
}

export function createPatentsTool(db: Db, pool: EvidencePool, user: AuthUser): AgentTool<typeof PatentParams, QueryDetails> {
  return {
    name: PATENTS_TOOL,
    label: '查专利登记',
    description: '查已经登记的专利。用户问谁有专利信息、某人登记了哪些专利时，用登记人判断管理归属。不要把申请人当成登记人，也不能据此断言法律权属。',
    parameters: PatentParams,
    execute: async (_id, params) => {
      const offset = params.offset ?? 0;
      const time = new Date().toISOString();
      if (params.record_id !== undefined) {
        const record = restoreLedgerEvidence(db, user, 'M-PATENT', params.record_id, time);
        return recordPage(pool, record === null ? [] : [record], record === null ? 0 : 1, 0);
      }
      const page = listPatentPage(db, {
        keyword: params.keyword?.trim(), limit: params.limit ?? DEFAULT_LIMIT,
        offset, filter: params.milestone ?? 'all', ...(params.registrant ? { registrant: params.registrant } : {}),
        ...(params.year === undefined ? {} : { year: params.year }), ...linkedPerson(params),
      }, patentView(user));
      return recordPage(pool, page.items.map((patent) => patentEvidence(patent, time)), page.matched, offset);
    },
  };
}

export function createThesesTool(db: Db, pool: EvidencePool, user: AuthUser): AgentTool<typeof ThesisParams, QueryDetails> {
  return {
    name: THESES_TOOL,
    label: '查大论文登记',
    description: '查大论文的作者、题目和研究方向。可以根据某个作者的方向继续寻找做过类似主题的人。相似是依据已登记的方向或题目做的比较。',
    parameters: ThesisParams,
    execute: async (_id, params) => {
      const time = new Date().toISOString();
      if (!hasPermission(user.role, 'thesis.read')) return recordPage(pool, [], 0, 0);
      if (params.record_id !== undefined) {
        const record = restoreLedgerEvidence(db, user, 'M-THESIS', params.record_id, time);
        return recordPage(pool, record === null ? [] : [record], record === null ? 0 : 1, 0);
      }
      const offset = params.offset ?? 0;
      const page = listTheses(db, { keyword: params.keyword?.trim(), limit: params.limit ?? DEFAULT_LIMIT, offset,
        ...linkedPerson(params) }, thesisView(user));
      return recordPage(pool, page.items.map((thesis) => thesisEvidence(thesis, time)), page.matched, offset);
    },
  };
}

const DatasetParams = Type.Object({
  keyword: Type.Optional(
    Type.String({
      description: '数据集名称、项目、路径、用途、来源、格式、版本、规模、标签或说明中的词。列出全部时省略。',
    }),
  ),
  ...PageParams,
});

export type SubmissionsArgs = Static<typeof SubmissionsParams>;
export type DatasetArgs = Static<typeof DatasetParams>;

/** 台账里的一条记录 → 引用卡片上逐行显示的结论字段。 */
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

/** 数据集的一条登记记录 + 此刻的核对结论 → 结论字段。 */
export function assetFields(asset: CodeAsset, probe: AssetProbe): CitationField[] {
  const fields: CitationField[] = [];
  if (asset.project !== null) fields.push({ label: '项目', value: asset.project });
  fields.push({ label: '路径', value: asset.location });
  // `host` 非空表示这份数据在别的机器上，本机不去探测 —— 必须说明，
  // 否则"无法核对"会被读成"数据没了"。
  fields.push({ label: '所在机器', value: asset.host ?? '本机（服务所在的这台）' });
  fields.push({ label: '核对结果', value: ASSET_CHECK_LABELS[probe.result] });
  fields.push({ label: '说明', value: probe.reason });
  if (asset.accessNote !== null && asset.accessNote !== '') {
    fields.push({ label: '获取方式', value: asset.accessNote });
  }
  if (asset.notes) fields.push({ label: '登记备注', value: asset.notes });
  for (const key of Object.keys(DATASET_PROFILE_LABELS) as (keyof typeof DATASET_PROFILE_LABELS)[]) {
    const value = asset.profile?.[key];
    if (value) fields.push({ label: DATASET_PROFILE_LABELS[key], value });
  }
  return fields;
}

export interface LiveToolDeps {
  db: Db;
  /**
   * 只取允许根目录白名单，而不是整份 `AppConfig`。
   *
   * 【为什么收窄】工具能拿到的东西越少，越难被误用：这两个工具本来只该读库
   * 和探白名单里的目录，给它们整份配置（含 API key、模型路径）没有任何必要。
   * 顺带的好处是验证脚本不必造一份完整的假配置。
   */
  config: { readonly codeRoots: readonly string[] };
  pool: EvidencePool;
  /** 注入当前时刻，便于测试固定时间；省略则取 `new Date()`。 */
  now?: () => Date;
}

/**
 * 查台账的工具**额外**要一份可见范围。
 *
 * 【为什么单独一个类型，而不是把 scope 放进 LiveToolDeps】
 *   数据集工具（`probe_dataset`）读的是"实验室共用的资产清单"，本来就不按人筛；
 *   给它一个必填的 scope，调用方只能随手塞一个假的进去，反而让"这个参数到底
 *   有没有生效"变得说不清。把 scope 收窄到真正需要它的那一个工具上，
 *   谁需要过滤、谁不需要，在类型上就是明写的。
 *
 * 【为什么工具也必须过滤，而且是这里最容易漏的一处】
 *   界面上的行级过滤只挡得住"直接打接口"的人。Agent 工具是**另一条读路径**：
 *   一个成员只要问"把台账里所有投稿列出来"，模型就会去调这个工具 ——
 *   工具不过滤的话，他不用越权访问任何接口，就能拿到全实验室的台账。
 *   所以过滤必须跟着工具走到最里面，而不是停在 HTTP 层。
 */
export interface SubmissionsToolDeps extends LiveToolDeps {
  scope: RowScope;
}

/**
 * 查投稿台账。
 *
 * 【它要顶住的是一种很自然的错误】库里同时存着"上传的投稿文档"和"台账记录"。
 * 文档里关于投稿的描述是**写下那一刻**的情况，而台账行是**现在**的情况。
 * 用户问"我投的 X 现在什么状态"，模型如果拿文档去答，给出的就是一条
 * 无法辨认新旧的历史结论 —— 这正是 GC-03 要拦的。所以工具描述里明写
 * "这类问题必须用本工具"，并且空结果时明确禁止改用文档作答。
 */
export function createSubmissionsTool(
  deps: SubmissionsToolDeps,
): AgentTool<typeof SubmissionsParams, QueryDetails> {
  return {
    name: SUBMISSIONS_TOOL,
    label: '查投稿台账',
    description:
      '查实验室的**投稿台账**（结构化记录）。问"我投的 X 现在什么状态""最近投出去的稿子"这类' +
      '**当前状态**的问题，必须用本工具查台账，不要用检索到的文档回答。' +
      '上传的文档里关于投稿的描述是"写下那一刻"的情况，用它回答"现在"会给出一个无法辨认新旧' +
      '的过时结论。返回带证据号（[En]）的台账记录，含状态、期刊、分区与时间。',
    parameters: SubmissionsParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<QueryDetails>> => {
      const now = deps.now ?? ((): Date => new Date());
      const queryTime = now().toISOString();
      const offset = params.record_id === undefined ? (params.offset ?? 0) : 0;
      const search = { keyword: params.keyword?.trim(), status: params.status, scope: deps.scope,
        ...(params.year === undefined ? {} : { year: params.year }), ...linkedPerson(params) };
      const selected = params.record_id === undefined ? null : getSubmissionFor(deps.db, params.record_id, deps.scope);
      const items = params.record_id === undefined
        ? searchSubmissions(deps.db, { ...search, limit: params.limit ?? DEFAULT_LIMIT, offset })
        : selected === null ? [] : [selected];
      const matched = params.record_id === undefined ? countMatchingSubmissions(deps.db, search) : items.length;

      if (matched === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                '台账里没有匹配的记录。**不要**改用检索到的文档来回答"现在的状态"——' +
                '文档记的是当时的情况，那会给出一个过时的结论。' +
                '可以换一个关键词再查一次；两次都没有，就如实告诉用户台账里没有这条记录。',
            },
          ],
          details: { newEvidenceIds: [], evidenceIds: [] },
        };
      }

      return recordPage(deps.pool, items.map((s): RecordEvidenceInput => ({
          recordType: 'M-SUBMIT',
          recordId: s.id,
          recordTitle: s.title,
          queryTime,
          recordUpdatedAt: s.updatedAt,
          fields: submissionFields(s),
      })), matched, offset);
    },
  };
}

/**
 * 查数据集在服务器上的位置，并现场核对它此刻还在不在。
 *
 * 【只查已登记的记录，不接受任意路径】C-FS 的硬边界是"允许根目录白名单"
 * （01 号 §6.1）。让模型直接给一个路径去探，等于把"这个路径该不该看"
 * 的判断交给模型 —— 而白名单的全部意义就是不做这件事。所以入参只有关键词，
 * 候选集永远是 `code_assets` 里那些已经登记过、且经过白名单校验的记录。
 *
 * 【为什么每次现探，不用库里的 last_check_result】那个值说的是"上次核对时"，
 * 而用户问的是"现在"。日期一过它就可能过期，拿它回答等于给一个无法辨认
 * 新旧的结论 —— 与台账那一条是同一个道理。`existsSync`/`statSync` 是纳秒级操作。
 */
export function createDatasetTool(
  deps: LiveToolDeps,
): AgentTool<typeof DatasetParams, QueryDetails> {
  return {
    name: DATASET_TOOL,
    label: '查数据集',
    description:
      '查**已登记的数据集**在服务器上的位置，并现场核对它此刻还在不在。' +
      '问"数据集 Y 在哪""那份数据还在吗"用它。返回带证据号（[En]）的记录，' +
      '含位置核对及已登记的用途、来源、格式、规模、标签、版本、获取方式。未填写的字段保持未知。',
    parameters: DatasetParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<QueryDetails>> => {
      const now = deps.now ?? ((): Date => new Date());
      const queryTime = now().toISOString();
      const limit = params.limit ?? DEFAULT_LIMIT;

      const offset = params.offset ?? 0;
      const items = searchCodeAssets(deps.db, { keyword: params.keyword, limit, offset });
      const matched = countMatchingCodeAssets(deps.db, params.keyword);
      if (matched === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                '没有登记过匹配的数据集。**不要**猜一个路径 —— 猜出来的路径即使格式正确也毫无依据。' +
                '可以换一个关键词再试；确实没有就如实告诉用户库里没有登记过这个数据集。',
            },
          ],
          details: { newEvidenceIds: [], evidenceIds: [] },
        };
      }

      // 根目录只在这一次查询里探一遍：逐条各探一次既慢，又可能出现
      // "同一批里前后结论不一致"（见 code/check.ts 的说明）。
      const roots = probeRoots(deps.config.codeRoots);

      return recordPage(deps.pool, items.map((asset) => {
        const probe = checkAsset(asset.location, asset.host, roots);
        const fields = assetFields(asset, probe);
        const doc = asset.documentationId ? getDocumentFile(deps.db, asset.documentationId) : null;
        if (doc) fields.push({ label: '关联说明文档', value: doc.title });
        return {
          recordType: 'M-CODE',
          recordId: asset.id,
          recordTitle: asset.name,
          queryTime,
          recordUpdatedAt: asset.updatedAt,
          fields,
        };
      }), matched, offset);
    },
  };
}
