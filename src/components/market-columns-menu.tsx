'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Keep checkbox interaction native; close on Escape, outside clicks and view changes. */
export function MarketColumnsMenu({ view, children }: { view: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  function fitMenu() {
    const element = menu.current;
    const panel = element?.querySelector<HTMLElement>('[role=group]');
    if (!element?.open || !panel) return;
    const box = element.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const upward = below < 260 && above > below;
    panel.style.top = upward ? 'auto' : 'calc(100% + 4px)';
    panel.style.bottom = upward ? 'calc(100% + 4px)' : 'auto';
    panel.style.maxHeight = `${Math.max(100, Math.min(470, upward ? above : below))}px`;
  }
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [view]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
        event.stopPropagation();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', fitMenu);
    window.addEventListener('scroll', fitMenu, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', fitMenu);
      window.removeEventListener('scroll', fitMenu, true);
    };
  }, []);
  return <details ref={menu} className="market-columns" onToggle={fitMenu}><summary>Columns</summary>
    <div role="group" aria-label={`${view === 'listed' ? 'Listed' : 'Tokenized'} columns`}>{children}</div>
  </details>;
}
