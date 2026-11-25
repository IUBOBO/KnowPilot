import { useLayoutEffect, useRef, useState } from 'react';
import katex from 'katex';

export default function MathFormula({ source, display }: { source: string; display: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  const scrollBox = useRef<HTMLSpanElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useLayoutEffect(() => {
    const element = target.current;
    if (element === null) return;

    try {
      katex.render(source, element, {
        displayMode: display,
        output: 'mathml',
        trust: false,
        strict: 'error',
        throwOnError: true,
        maxExpand: 200,
        maxSize: 18,
      });
    } catch {
      element.textContent = source;
    }
    const box = scrollBox.current;
    if (box === null) return;
    const update = () => setScrollable(box.scrollWidth > box.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [source, display]);

  if (display) return <span ref={target} />;

  return (
    <span
      ref={scrollBox}
      className="ask-answer-math-inline"
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? 'region' : undefined}
      aria-label={scrollable ? '回答行内公式' : undefined}
    ><span ref={target} /></span>
  );
}
