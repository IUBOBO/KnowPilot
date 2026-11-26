/** Query-time content and document policy. Original chunks and citation ids remain untouched. */
import { searchTerms, type Material } from '@knowpilot/shared';
import type { Db } from '../db/index.ts';
import { parseSectionPath } from './repo.ts';

export interface Passage {
  id: string;
  doc_id: string;
  title: string;
  file_name: string | null;
  material: string;
  ordinal: number;
  page: number | null;
  section_path: string | null;
  text: string;
}

const normalize = (text: string): string => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, (ch) => ch==='+' || ch==='-' ? ch : '');
const stripExtension = (text: string): string => text.replace(/\.(pdf|docx|md|txt)$/iu, '');
const isQuestion = (query: string): boolean => /[?？]|什么|怎么|如何|多少|哪些|为何|为什么|要求|多久/iu.test(query);
const stopTerms = new Set(['主要', '最终', '选择', '具体', '应该', '介绍', '这个', '什么', '多少', '论文']);

/** A header which carries no statement is unsuitable as standalone answer evidence. */
export function isTitleOnly(row: Pick<Passage, 'title' | 'section_path' | 'text'>): boolean {
  const text = row.text.trim();
  if (text.length > 180 || /[。！？!?；;<>≤≥=%℃]/u.test(text)) return false;
  const key = normalize(text);
  return key !== '' && [stripExtension(row.title), ...parseSectionPath(row.section_path)]
    .some((label) => key === normalize(label));
}

function isContents(text: string): boolean {
  return (text.match(/\.{5,}|…{3,}/gu)?.length ?? 0) >= 2;
}

function quality(row: Passage, query: string): number {
  if (isContents(row.text)) return 0.05;
  if (isTitleOnly(row)) return 0.08;
  const text = row.text.trim();
  if (!/参考|引用|文献|doi|reference/iu.test(query)
      && (/^(?:参考文献|references)\s*$/iu.test(text)
        || (text.match(/(?:^|\n)\s*\[\d+\]/gu)?.length ?? 0) >= 2
        || /^\[\d+\].{8,}(?:\[J\]|\[C\]|doi|\b(?:19|20)\d{2}\b)/isu.test(text))) return 0.12;
  if (!/作者|基金|资助|通信|通讯|邮箱|author|funding|affiliation/iu.test(query)
      && /基金项目|收稿日期|通信联系人|e-?mail\s*[:：]/iu.test(text)
      && (text.match(/[。！？]|[.!?](?=\s|$)/gu)?.length ?? 0) < 2) return 0.15;
  return 1;
}

/** Only explicit self-identification creates a model alias; a comparison or reference does not. */
function declaredAliases(text: string): string[] {
  const aliases: string[] = [];
  for (const match of text.matchAll(/\bour\s+(?:proposed\s+)?(?:model|network|method)\s*[,，:]?\s*([A-Za-z][A-Za-z0-9]*(?:[-+][A-Za-z0-9]*)*)/giu)) {
    if (match[1]) aliases.push(match[1]);
  }
  for (const match of text.matchAll(/(?:本文|我们).{0,12}提出[^。\n]{0,100}[（(][^）)]{0,80}?,\s*([A-Za-z][A-Za-z0-9]*(?:[-+][A-Za-z0-9]*)*)\s*[)）]/gu)) {
    if (match[1]) aliases.push(match[1]);
  }
  return aliases.filter((alias) => !/^(?:is|the|and|with|uses|has|can)$/iu.test(alias));
}

function hasAlias(query: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9+\\-])${escaped}(?![A-Za-z0-9+\\-])`, 'iu').test(query);
}

export interface RetrievalPolicy {
  rows: ReadonlyMap<string, Passage>;
  scope: ReadonlySet<string>;
  preferredDocuments: readonly string[];
  bodyQuery: string;
  weight: (id: string) => number;
}

export function createRetrievalPolicy(
  db: Db, query: string, material?: Material, documentId?: string, documentIds?: readonly string[],
): RetrievalPolicy {
  const selected = documentIds === undefined ? null : JSON.stringify(documentIds);
  const all = db.prepare(`SELECT c.id,c.doc_id,c.ordinal,c.page,c.section_path,c.text,
       d.title,d.file_name,d.material FROM doc_chunks c JOIN documents d ON d.id=c.doc_id
       WHERE (? IS NULL OR d.material=?) AND (? IS NULL OR c.doc_id=?)
       AND (? IS NULL OR c.doc_id IN (SELECT value FROM json_each(?))) ORDER BY c.doc_id,c.ordinal`)
    .all(material ?? null, material ?? null, documentId ?? null, documentId ?? null, selected, selected) as unknown as Passage[];
  const byDoc = new Map<string, Passage[]>();
  for (const row of all) {
    const list = byDoc.get(row.doc_id) ?? []; list.push(row); byDoc.set(row.doc_id, list);
  }
  const eligible = all.filter((row) => {
    // Preserve title-only documents, and explicit requests to list headings or the contents.
    if (/目录|章节标题|章节列表|contents|headings/iu.test(query)) return true;
    const hasBody = byDoc.get(row.doc_id)?.some((r) => !isTitleOnly(r) && !isContents(r.text));
    return !hasBody || (!isTitleOnly(row) && !isContents(row.text));
  });
  const matched = new Map<string, string[]>();
  const qKey = normalize(query);
  const compareQuery = /对比|比较|区别|异同|差异|不同|综述|哪些论文|相关论文|其他论文|被.{0,8}引用|compare|survey|related papers/iu.test(query);
  for (const [id, rows] of byDoc) {
    const first = rows[0]; if (!first) continue;
    const names = [...new Set([stripExtension(first.title), stripExtension(first.file_name ?? '')])]
      .filter((name) => normalize(name).length >= 4);
    const anchors = names.filter((name) => /[\u3400-\u9fff]/u.test(name)
      ? qKey.includes(normalize(name)) : hasAlias(query,name));
    // Aliases are read from the opening, never from arbitrary mentions in a paper's body.
    if (!compareQuery && (isQuestion(query) || !/[\s\u3400-\u9fff]/u.test(query))) {
      const opening = rows.filter((row) => row.ordinal < 4).map((row) => row.text).join('\n').slice(0,6000);
      anchors.push(...declaredAliases(opening).filter((alias) => hasAlias(query, alias)));
    }
    if (anchors.length > 0) matched.set(id, anchors);
  }
  // An ambiguous alias never silently restricts the query to one of its possible papers.
  const preferredDocuments = matched.size === 1 && !compareQuery ? [...matched.keys()] : [];
  const preferred = new Set(preferredDocuments);
  const candidates = preferred.size > 0 ? eligible.filter((r) => preferred.has(r.doc_id)) : eligible;
  const scope = new Set(candidates.map((r) => r.id));
  let bodyQuery = query;
  if (preferred.size > 0) {
    for (const anchor of [...(matched.get(preferredDocuments[0]!) ?? [])].sort((a,b) => b.length-a.length)) {
      bodyQuery = bodyQuery.replaceAll(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'giu'),' ');
    }
    bodyQuery = bodyQuery.replace(/[《》「」“”]/gu,' ').trim();
  }
  const rows = new Map(all.map((r) => [r.id,r]));
  const terms = searchTerms(bodyQuery).filter((t) => !stopTerms.has(t.toLowerCase()));
  const methodQuestion = /方法|模型|结构|架构|增加|改进|method|architecture/iu.test(bodyQuery);
  const numericQuestion = /多少|权重|比例|阈值|率|字数|至少|多久|数量|几个月/iu.test(bodyQuery);
  const weight = (id: string): number => {
    const row = rows.get(id); if (!row) return 0;
    let factor = quality(row, query);
    if (!isQuestion(query)) return factor;
    const text = row.text.toLowerCase();
    const covered = terms.filter((t) => text.includes(t.toLowerCase())).length / Math.max(1,terms.length);
    let relevance = 0.7 + 0.15 * covered;
    if (methodQuestion) {
      const methodHeading = /^(?:\d+(?:\.\d+)*\s+)?(?:研究方法|模型|网络结构|总体架构|methods|model|architecture)(?:\s|[：:])/iu.test(row.text);
      const selfDescription = /本文.{0,12}(?:提出|采用|构建)|\b(?:we|our).{0,35}(?:propos|model|network)/iu.test(row.text.slice(0,1000));
      relevance = methodHeading || selfDescription ? 1 : 0.6 + 0.15 * covered;
    }
    if (numericQuestion) {
      let direct = false;
      if (/查重|重复率/u.test(query)) direct = /(?:查重率|重复率)\s*[<≤≥>=]\s*\d/u.test(text);
      else if (/权重/u.test(query)) direct = /(?:权重.{0,16}为|分别为).{0,12}\d/u.test(text);
      else if (/字数|多少字/u.test(query)) direct = /(?:不少于|至少|不低于)\s*\d+\s*字/u.test(text);
      else if (/多久|几个月/u.test(query)) direct = /(?:通过|间隔).{0,12}\d+\s*(?:个月|月|年)/u.test(text);
      else direct = /\d/u.test(text) && /数量|分别|\|/u.test(text);
      relevance = direct ? 1 : 0.55 + 0.15 * covered;
    }
    // Keep the scope distinction in broad academic-rule questions, even inside the same chapter.
    if (/硕士/u.test(query) && !/博士/u.test(query) && /博士/u.test(text) && !/硕士/u.test(text)) factor *= 0.3;
    if (/博士/u.test(query) && !/硕士/u.test(query) && /硕士/u.test(text) && !/博士/u.test(text)) factor *= 0.3;
    return factor * Math.min(1,relevance);
  };
  return {rows,scope,preferredDocuments,bodyQuery,weight};
}
