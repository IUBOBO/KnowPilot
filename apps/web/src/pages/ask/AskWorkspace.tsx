import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { Modal } from '../../components/Modal.tsx';

const DOCKED_QUERY = '(min-width: 1080px)';

function subscribeToWidth(onChange: () => void) {
  const query = window.matchMedia(DOCKED_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function canDockReader() {
  return window.matchMedia(DOCKED_QUERY).matches;
}

interface ReaderProps {
  title: string;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}

function DockedReader({ title, triggerRef, onClose, children }: ReaderProps) {
  const headingId = useId();
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, []);

  function closeFromReader() {
    onClose();
    triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <aside className="ask-evidence-reader card" aria-labelledby={headingId} onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeFromReader();
    }}>
      <div className="ask-reader-header">
        <h2 id={headingId}>{title}</h2>
        <button className="link-btn" type="button" ref={close} onClick={closeFromReader}>关闭来源</button>
      </div>
      {children}
    </aside>
  );
}

export function AskWorkspace({ reader, children }: { reader: ReaderProps; children: ReactNode }) {
  const docked = useSyncExternalStore(subscribeToWidth, canDockReader);
  return (
    <div className={docked && reader.open ? 'ask-workspace ask-workspace-with-reader' : 'ask-workspace'}>
      <div className="ask-conversation">{children}</div>
      {reader.open && (docked ? <DockedReader {...reader} /> : (
        <Modal
          open
          variant="drawer"
          title={reader.title}
          onClose={reader.onClose}
          returnFocusTo={reader.triggerRef}
          footer={<button type="button" onClick={reader.onClose}>关闭来源</button>}
        >
          {reader.children}
        </Modal>
      ))}
    </div>
  );
}
