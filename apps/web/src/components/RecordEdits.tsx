import type { RecordEdit } from '@knowpilot/shared';
import { fmtDateTime } from '../format.ts';

const LABELS: Record<string, string> = {
  title: '标题', name: '名称', algorithmAbbr: '稿件简称', submitterName: '投稿人',
  journalName: '期刊', submittedOn: '投稿日期', statusSince: '状态日期',
  submissionNumber: '投稿编号', notes: '备注', patentNo: '专利号',
  applicantName: '申请人', applicantPersonId: '关联申请人',
  firstSubmittedOn: '首次提交', substantiveExamOn: '实审日期', publishedOn: '公开日期', grantedOn: '授权日期',
  submitterPersonId: '关联投稿人',
  personId: '关联人员', authorName: '作者', direction: '研究方向', grade: '成绩',
};

function display(value: string | null): string {
  return value === null || value === '' ? '未填写' : value;
}

/** 只呈现服务端已授权返回的变更字段。 */
export function RecordEdits({ edits }: { edits: readonly RecordEdit[] }) {
  if (edits.length === 0) return null;
  return (
    <details className="record-edits">
      <summary>资料修改记录 <span>{edits.length} 次</span></summary>
      <ol>
        {edits.map((edit) => (
          <li key={edit.id}>
            <p className="record-edit-meta">
              <time dateTime={edit.changedAt}>{fmtDateTime(edit.changedAt)}</time>
              {edit.changedByName !== null && <> · {edit.changedByName}</>}
            </p>
            <ul>
              {Object.entries(edit.changes).map(([field, change]) => (
                <li key={field}>
                  <strong>{LABELS[field] ?? field}</strong>
                  {field === 'personId' || field === 'applicantPersonId'
                    ? <span>关联关系已调整</span>
                    : <span><s>{display(change.before)}</s><span aria-hidden="true"> → </span>{display(change.after)}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  );
}
