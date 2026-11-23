import { useEffect, useState } from 'react';
import type { ListPeopleResponse, Person } from '@knowpilot/shared';
import { apiGet, isAbort } from '../api.ts';

/** 先显示常用人员，输入姓名或学号后从服务端检索全部主档。 */
export function PersonPicker({
  name, people, initialId, initialName, onSelect,
}: {
  name: string;
  people: readonly Person[];
  initialId: string;
  initialName: string | null;
  onSelect?: (person: Person | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly Person[]>(people);
  const [selectedId, setSelectedId] = useState(initialId);
  const [selected, setSelected] = useState<Person | null>(people.find((p) => p.id === initialId) ?? null);
  const [searchError, setSearchError] = useState(false);

  useEffect(() => {
    if (query.trim() === '') {
      setResults(people);
      setSearchError(false);
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void apiGet<ListPeopleResponse>(`/api/v1/people?q=${encodeURIComponent(query.trim())}&limit=200`, ac.signal)
        .then((res) => { setResults(res.items); setSearchError(false); })
        .catch((err) => { if (!isAbort(err)) setSearchError(true); });
    }, 250);
    return () => { window.clearTimeout(timer); ac.abort(); };
  }, [query, people]);

  const selectedOption = selectedId === '' || results.some((p) => p.id === selectedId)
    ? null
    : selected;
  return (
    <div className="person-picker" style={{ flex: '1 1 220px' }}>
      <label className="field">
        <span>查找关联人员</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入姓名或学号搜索全部人员" />
      </label>
      <label className="field">
        <span>关联人员（可留空）</span>
        <select name={name} value={selectedId} onChange={(e) => {
          setSelectedId(e.target.value);
          const person = results.find((p) => p.id === e.target.value) ??
            (selected?.id === e.target.value ? selected : null);
          setSelected(person);
          onSelect?.(person);
        }}>
          <option value="">不关联</option>
          {selectedOption !== null && <option value={selectedId}>{selectedOption.name}</option>}
          {selectedOption === null && selectedId !== '' && !results.some((p) => p.id === selectedId) && (
            <option value={selectedId}>{initialName ?? '已关联人员'}</option>
          )}
          {results.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.studentNoVisible && p.studentNo !== null ? `（${p.studentNo}）` : ''}</option>
          ))}
        </select>
      </label>
      {searchError && <p className="dim" role="status">人员搜索暂不可用，请稍后重试。</p>}
    </div>
  );
}
