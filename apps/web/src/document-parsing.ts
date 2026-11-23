import type { DocumentSummary, IngestReport } from '@knowpilot/shared';
import type { ApiError } from './api.ts';

export interface DocumentParsing {
  status: string;
  tone: 'ok' | 'warn' | 'err';
  reminder: string | null;
  details: readonly { label: string; text: string }[];
}

const MISSING_FILE = /原件.*(?:不在磁盘|不存在|找不到|丢失)|文件.*不存在/u;

export function describeDocumentParsing(doc: DocumentSummary, report?: IngestReport | null): DocumentParsing {
  const notes = (report?.warnings ?? doc.ingestNote?.split('\n') ?? []).filter(Boolean);
  const text = notes.join('\n');
  const chunks = report?.chunkCount ?? doc.chunkCount;
  const searchable = doc.status === 'ready' && chunks > 0;
  const previousContent = doc.status === 'failed' && doc.chunkCount > 0;
  const tables = text.match(/识别出\s*(\d+)\s*张表格/u)?.[1];
  const formulasSkipped = /\}oMath(?:Para)?\b/u.test(text);
  const stylesChanged = /unrecogni[sz]ed (?:paragraph|run) style/iu.test(text);
  const scanCount = report?.ocrPageCount || Number(text.match(/识别出文字（共\s*(\d+)\s*页）/u)?.[1] ?? 0);
  const scanDisabled = text.includes('OCR 已关闭');
  const scanUnavailable = text.includes('OCR 模型文件缺失');
  const scannedPagesMissing = scanDisabled || scanUnavailable || /OCR 失败|OCR 全部失败|页没有内容|这些页的内容检索不到/u.test(text);
  const scanUnclear = /识别置信度偏低/u.test(text);
  const partialSearch = searchable && (report?.embeddedChunkCount ?? doc.embeddedChunkCount) < chunks;
  const empty = /没有提取到|文件是空的|文件内容为空|没有任何可检索|Word 解析提示/u.test(text) ||
    scannedPagesMissing || (report != null && chunks === 0);
  const otherContentSkipped = notes.some((note) =>
    /unrecogni[sz]ed element|was ignored/iu.test(note) && !/\}oMath(?:Para)?\b/u.test(note));
  const details: { label: string; text: string }[] = [];
  const reminders: string[] = [];

  if (doc.status === 'uploaded' && report == null) {
    return { status: '待解析', tone: 'warn', reminder: null, details };
  }
  if (searchable) {
    details.push({ label: '可检索内容', text: `已整理为 ${chunks} 个可检索片段${tables === undefined ? '' : `，识别出 ${tables} 张表格`}。` });
  }
  if (formulasSkipped && searchable) reminders.push('部分公式需查看原件');
  if (formulasSkipped) details.push({ label: '公式', text: '部分 Word 公式未收录。查看具体公式时，请对照原件。' });
  if (scannedPagesMissing && searchable) reminders.push('部分扫描页未能识别');
  if (scanUnclear && searchable && !scannedPagesMissing) reminders.push('部分扫描文字需核对原件');
  if (scanCount > 0 || scannedPagesMissing || scanUnclear) {
    const missed = text.match(/其余\s*(\d+)\s*页没有内容/u)?.[1];
    const pages = Array.from(new Set(Array.from(text.matchAll(/第\s*(\d+)\s*页 OCR 失败/gu), (match) => match[1]!)));
    const detailsText = [
      scanCount > 0 ? `已从 ${scanCount} 页扫描件识别出文字。` : '',
      missed !== undefined ? `达到单次识别页数上限，另有 ${missed} 页未处理。` : '',
      pages.length > 0 ? `第 ${pages.slice(0, 6).join('、')} 页${pages.length > 6 ? `等 ${pages.length} 页` : ''}识别失败。` : '',
      scanDisabled ? '扫描识别当前未开启。' : '',
      scanUnavailable ? '扫描识别所需的文件缺失，请联系管理员。' : '',
      scannedPagesMissing && !scanDisabled && !scanUnavailable && missed === undefined && pages.length === 0
        ? '有扫描页未能转换为可检索的文字。' : '',
      scanUnclear ? '部分文字识别不清，引用时请核对原件。' : '',
      scanCount > 0 && !scanUnclear ? '引用扫描文字时请核对原件。' : '',
    ];
    details.push({ label: '扫描页', text: detailsText.join('') });
  }
  if (stylesChanged && searchable) {
    details.push({ label: '文档排版', text: '部分标题或列表样式未保留，原有的章节定位可能不完整。已提取的文字仍可查询。' });
  }
  if (partialSearch) {
    reminders.push('按意思查询的范围有限');
    details.push({ label: '查询范围', text: '可以按关键词查询。按意思查找的准备尚未完成，部分内容可能搜不到。' });
  }
  if (otherContentSkipped && searchable) {
    if (!formulasSkipped) reminders.push('部分内容需查看原件');
    details.push({ label: '其他内容', text: '文档中部分特殊内容未能提取。需要核对时，请打开原件。' });
  }
  if (!searchable) {
    const noText = empty || doc.status === 'ready';
    let nextStep = '请确认原件能正常打开，再上传一份可读取的版本。';
    if (MISSING_FILE.test(text)) {
      nextStep = '系统找不到原文件，请重新上传原件。';
    } else if (scannedPagesMissing) {
      nextStep = '可以上传带文字的版本，或请管理员检查扫描识别后重建。';
    } else if (noText) {
      nextStep = '请打开原件，确认其中有可选中的文字，再上传可读取的版本。';
    }
    return {
      status: previousContent ? '旧内容可检索' : noText ? '暂不可检索' : '解析失败',
      tone: previousContent || noText ? 'warn' : 'err',
      reminder: previousContent ? '本次解析未完成，仍可查询之前收录的内容' : noText ? '未提取到可检索的文字' : '这份文档未能解析',
      details: [{ label: '如何处理', text: nextStep }, ...details],
    };
  }

  return {
    status: scannedPagesMissing ? '部分内容可检索' : '已就绪',
    tone: reminders.length > 0 ? 'warn' : 'ok',
    reminder: reminders.length > 0 ? reminders.join('，') : null,
    details,
  };
}

export function describeParsingFailure(error: ApiError, operation: 'upload' | 'reindex'): string {
  const { code, message } = error.body.error;
  if (code === 'unauthenticated') return '登录已过期，请重新登录后再试。';
  if (code === 'permission_denied') return '当前账号没有这个操作的权限，请联系管理员。';
  if (/\.doc 是 Word|Word 97-2003/u.test(message)) return '请用 Word 将旧版文档另存为 .docx 后再上传。';
  if (/扩展名|上传格式|只支持|不支持.*格式/u.test(message)) return '请选择 PDF、Word（.docx）、Markdown 或纯文本文件。';
  if (/文件过大|超过.{0,20}(上限|限制)|50\s*MB/u.test(message)) return '文件超过大小上限，请缩小文件或分成几份后再上传。';
  if (/文件是空的|文件内容为空|空文件|文件大小为 0/u.test(message)) return '文件没有内容，请选择一份非空文件。';
  if (/旧索引已保留/u.test(message)) return '本次没能完成重建，之前可查询的内容仍可使用。请稍后重试。';
  if (MISSING_FILE.test(message)) return '系统找不到原文件，请重新上传原件。';
  if (operation === 'reindex' && code === 'not_found') return '这份文档已无法访问，请刷新列表。';
  if (/Word 文件解析失败|PDF.*(打开失败|解析失败)|损坏|受密码/u.test(message)) {
    return '系统没能打开文件。请确认原件可以正常打开，并上传无需密码的版本。';
  }
  return operation === 'upload'
    ? '这次没能完成上传和解析，请重试。若仍失败，请联系管理员。'
    : '这次没能完成重建，请重试。若仍失败，请联系管理员。';
}
