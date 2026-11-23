/**
 * ⌘K / Ctrl+K 命令面板（O10）。
 *
 * 【为什么页面用前端清单、实体走服务端】页面是编译期就确定的（权限过滤后的
 *   导航项），本地筛即可、零延迟；数据集 / 投稿 / 文档在后端，且投稿有行级
 *   可见范围 —— 它必须在服务端筛，前端拿到的本来就只能是可见的那些。
 *
 * 【为什么复用一个接口而不是打三个列表接口】三个列表接口各自带一整套
 *   分页、计数与字段，面板只需要"标题 + 一行补充"。一个专门的短名单接口
 *   让每类各查 5 条，既不会为了找一条投稿把 200 条全传过来，也不会让
 *   "面板该显示什么"散在三个前端调用里。
 *
 * 【为什么结果都是按钮、焦点却留在输入框】这是 combobox 的标准做法：
 *   用户边打边用上下键选，焦点一旦跳进列表就没法继续输入。选中项通过
 *   `aria-activedescendant` 告诉读屏软件，视觉上是 `.active` 底色。
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { QUICK_SEARCH_KINDS, QUICK_SEARCH_LABELS, type QuickSearchHit, type QuickSearchResponse } from '@knowpilot/shared';
import { apiGet, isAbort, toApiError } from '../api.ts';
import { Modal } from './Modal.tsx';
import { searchHitHref } from '../search-links.ts';

export interface PalettePage {
  to: string;
  label: string;
  /** 所属导航组；空组标题时传「常用」。 */
  group: string;
}

interface PaletteItem {
  key: string;
  title: string;
  detail: string;
  href: string;
  /** 结果类型的小标签。 */
  kind: string;
}

interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

function pageHref(page: PalettePage): string {
  return page.to;
}

export function CommandPalette({ pages }: { pages: readonly PalettePage[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly QuickSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const seqRef = useRef(0);

  // 快捷键在所有登录后的页面生效：面板挂在 Layout 里，而 Layout 正是
  // 除 /login 之外所有路由的外壳。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setOpen((prev) => !prev);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // 每次打开都回到干净状态：上一轮的关键词与选中项不该跟着进来。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setSearchError(null);
    setActive(0);
  }, [open]);

  // 防抖 + 取消：每敲一个字都发一次请求会让后到的旧响应盖掉新结果，
  // 也会在关闭面板后继续占着网络。AbortController 把两者一起解决。
  useEffect(() => {
    const keyword = query.trim();
    if (!open || keyword === '') {
      setHits([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    const ac = new AbortController();
    const seq = ++seqRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      apiGet<QuickSearchResponse>(
        `/api/v1/quick-search?q=${encodeURIComponent(keyword)}`,
        ac.signal,
      )
        .then((body) => {
          if (seq !== seqRef.current) return;
          setHits(body.items);
          setSearchError(null);
        })
        .catch((err: unknown) => {
          if (isAbort(err) || seq !== seqRef.current) return;
          setHits([]);
          setSearchError(toApiError(err).body.error.message);
        })
        .finally(() => {
          if (seq === seqRef.current) setSearching(false);
        });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query, open]);

  const lowered = query.trim().toLowerCase();
  const pageItems: PaletteItem[] = pages
    .filter((page) => {
      if (lowered === '') return true;
      return (
        page.label.toLowerCase().includes(lowered) ||
        page.group.toLowerCase().includes(lowered)
      );
    })
    .map((page) => ({
      key: `page:${page.to}`,
      title: page.label,
      detail: page.group,
      href: pageHref(page),
      kind: '页面',
    }));

  const groups: PaletteGroup[] = [
    { label: '页面', items: pageItems },
    ...QUICK_SEARCH_KINDS.map((kind) => ({
      label: QUICK_SEARCH_LABELS[kind],
      items: hits
        .filter((hit) => hit.kind === kind)
        .map((hit) => ({
          key: `${hit.kind}:${hit.id}`,
          title: hit.title,
          detail: hit.detail,
          href: searchHitHref(hit),
          kind: QUICK_SEARCH_LABELS[hit.kind],
        })),
    })),
  ].filter((group) => group.items.length > 0);

  const flat = groups.flatMap((group) => group.items);
  const current = flat[Math.min(active, flat.length - 1)];
  const listId = 'palette-results';
  const activeId = current === undefined ? undefined : `palette-${current.key}`;

  // 选中项可能滚出可视区（结果多于面板高度）。只滚列表自身，
  // `block: 'nearest'` 不会把整页也带着跳。
  useEffect(() => {
    if (!open || activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
    // activeId 已经编码了"哪一行"；把整个 current 对象放进依赖会让每次
    // 渲染都重跑一次（对象每轮都是新的），滚动调用也就跟着每轮都触发。
  }, [open, activeId]);

  function close() {
    setOpen(false);
  }

  function go(item: PaletteItem) {
    close();
    navigate(item.href);
  }

  function move(delta: number) {
    if (flat.length === 0) return;
    setActive((prev) => (prev + delta + flat.length) % flat.length);
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // 中文输入法选词时按回车是在确认候选字，不是"打开"。
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      if (current === undefined) return;
      event.preventDefault();
      go(current);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="command-trigger"
        aria-label="搜索或跳转"
        onClick={() => setOpen(true)}
      >
        <span>搜索或跳转</span>
        <kbd>{navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <Modal
        open={open}
        title="搜索或跳转"
        onClose={close}
        returnFocusTo={triggerRef}
        footer={
          <p className="palette-hint">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 打开</span>
            <span><kbd>Esc</kbd> 关闭</span>
          </p>
        }
      >
        <input
          type="text"
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          {...(activeId === undefined ? {} : { 'aria-activedescendant': activeId })}
          placeholder="搜页面、数据集、投稿、文档…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
        />

        {searchError !== null && (
          <p className="palette-note err">资料搜索失败：{searchError}（页面仍可跳转）</p>
        )}
        {searching && <p className="palette-note dim">正在搜索资料…</p>}
        {!searching && lowered !== '' && flat.length === 0 && searchError === null && (
          <p className="palette-note dim">没有匹配的页面、数据集、投稿或文档。</p>
        )}
        {lowered === '' && (
          <p className="palette-note dim">输入关键词可以搜索数据集、投稿与文档。</p>
        )}

        <ul className="palette-list" id={listId} role="listbox" aria-label="跳转结果">
          {groups.map((group) => (
            <li key={group.label} role="presentation">
              <p className="palette-group-title">{group.label}</p>
              <ul role="group" aria-label={group.label}>
                {group.items.map((item) => {
                  const index = flat.findIndex((candidate) => candidate.key === item.key);
                  const selected = item.key === current?.key;
                  return (
                    <li key={item.key} role="none">
                      <button
                        type="button"
                        id={`palette-${item.key}`}
                        role="option"
                        aria-selected={selected}
                        className={selected ? 'palette-option active' : 'palette-option'}
                        onMouseEnter={() => setActive(index < 0 ? 0 : index)}
                        onClick={() => go(item)}
                      >
                        <span className="palette-option-text">
                          <span className="palette-option-title">{item.title}</span>
                          <span className="palette-option-detail">{item.detail}</span>
                        </span>
                        <span className="palette-kind">{item.kind}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
