'use client';

import { useEffect, useRef, useState } from 'react';

/** Separate, validated preferences; unavailable browser storage is non-fatal. */
export function useMarketColumns<T extends string>(key: string, all: readonly T[], defaults: readonly T[]) {
  const [columns, setColumns] = useState<readonly T[]>(defaults);
  const current = useRef<readonly T[]>(defaults);
  const edited = useRef(false);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (Array.isArray(saved)) {
        const valid = all.filter(column => saved.includes(column));
        if (valid.length) void Promise.resolve().then(() => {
          if (!edited.current) { current.current = valid; setColumns(valid); }
        });
      }
    } catch { /* Use defaults if storage is missing or invalid. */ }
  }, [key, all]);
  function save(next: readonly T[]) {
    if (!next.length) return;
    edited.current = true;
    current.current = next;
    setColumns(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Session preference still works. */ }
  }
  return { columns, toggle: (column: T, checked: boolean) => save(all.filter(value => value === column ? checked : current.current.includes(value))),
    reset: () => save(defaults) };
}
