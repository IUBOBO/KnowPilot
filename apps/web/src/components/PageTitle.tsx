import type { ReactNode } from 'react';
import { NavGlyph, type NavIconName } from '../nav-icons.tsx';

/** A page uses the same symbol as its navigation item. */
export function PageTitle({ icon, children }: { icon: NavIconName; children: ReactNode }) {
  return (
    <div className="page-title">
      <span className="page-title-icon"><NavGlyph name={icon} size={30} /></span>
      <h1>{children}</h1>
    </div>
  );
}
