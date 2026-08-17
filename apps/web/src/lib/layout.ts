/**
 * Home-screen personalisation.
 *
 * The *server* decides which portlets an employee may see -- that is a
 * permission, and it is not negotiable from the browser. This module only
 * decides how the ones they already have are arranged: order, width, and
 * whether a portlet is folded away. Losing this state loses nothing but a
 * preference, so it lives in localStorage keyed by user, not in the database.
 *
 * Every stored decision is reconciled against the server list on each load:
 * a portlet that has been revoked disappears from the layout, and a portlet
 * that has just been granted appears in its server-suggested position rather
 * than being silently hidden because the saved layout predates it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

export interface LayoutEntry {
  key: string;
  /** Grid columns out of twelve. */
  width: number;
  hidden: boolean;
}

export interface PortletSeed {
  key: string;
  width: number;
  order: number;
}

/** The widths a portlet can cycle through -- third, half, two-thirds, full. */
export const WIDTH_STEPS = [4, 6, 8, 12] as const;

const keyFor = (userId: string) => `worood.home.layout.${userId || 'anonymous'}`;

function load(userId: string): LayoutEntry[] | null {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (e): e is LayoutEntry =>
        !!e && typeof e.key === 'string' && typeof e.width === 'number' && typeof e.hidden === 'boolean',
    );
  } catch {
    return null;
  }
}

function save(userId: string, entries: LayoutEntry[]): void {
  try { localStorage.setItem(keyFor(userId), JSON.stringify(entries)); } catch { /* preference only */ }
}

/**
 * Merge what the server offers with what the user arranged. Server order is the
 * fallback for anything the saved layout has never seen.
 */
export function reconcile(seeds: PortletSeed[], stored: LayoutEntry[] | null): LayoutEntry[] {
  const bySeed = new Map(seeds.map((s) => [s.key, s]));
  const kept = (stored ?? [])
    .filter((e) => bySeed.has(e.key))
    .map((e) => ({ ...e, width: bySeed.has(e.key) ? e.width : bySeed.get(e.key)!.width }));
  const known = new Set(kept.map((e) => e.key));
  const added = seeds
    .filter((s) => !known.has(s.key))
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ key: s.key, width: s.width, hidden: false }));
  return [...kept, ...added];
}

export function useHomeLayout(userId: string, seeds: PortletSeed[]) {
  const seedSignature = seeds.map((s) => `${s.key}:${s.width}:${s.order}`).join('|');

  const [entries, setEntries] = useState<LayoutEntry[]>(() => reconcile(seeds, load(userId)));
  const [customising, setCustomising] = useState(false);

  /* Re-reconcile whenever the granted set changes or the user changes. */
  useEffect(() => {
    setEntries(reconcile(seeds, load(userId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, seedSignature]);

  const commit = useCallback((next: LayoutEntry[]) => {
    setEntries(next);
    save(userId, next);
  }, [userId]);

  const move = useCallback((from: string, to: string) => {
    if (from === to) return;
    setEntries((prev) => {
      const fromIdx = prev.findIndex((e) => e.key === from);
      const toIdx = prev.findIndex((e) => e.key === to);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [lifted] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, lifted);
      save(userId, next);
      return next;
    });
  }, [userId]);

  /** Nudge one slot in either direction -- the keyboard path for reordering. */
  const nudge = useCallback((key: string, delta: -1 | 1) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.key === key);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      save(userId, next);
      return next;
    });
  }, [userId]);

  const resize = useCallback((key: string, delta: -1 | 1) => {
    setEntries((prev) => {
      const next = prev.map((e) => {
        if (e.key !== key) return e;
        const at = WIDTH_STEPS.indexOf(e.width as (typeof WIDTH_STEPS)[number]);
        const from = at < 0 ? 0 : at;
        const to = Math.min(WIDTH_STEPS.length - 1, Math.max(0, from + delta));
        return { ...e, width: WIDTH_STEPS[to] };
      });
      save(userId, next);
      return next;
    });
  }, [userId]);

  const toggleHidden = useCallback((key: string) => {
    setEntries((prev) => {
      const next = prev.map((e) => (e.key === key ? { ...e, hidden: !e.hidden } : e));
      save(userId, next);
      return next;
    });
  }, [userId]);

  const reset = useCallback(() => {
    try { localStorage.removeItem(keyFor(userId)); } catch { /* nothing to clear */ }
    setEntries(reconcile(seeds, null));
  }, [userId, seedSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => entries.filter((e) => !e.hidden), [entries]);
  const hidden = useMemo(() => entries.filter((e) => e.hidden), [entries]);
  const isDefault = useMemo(() => {
    const base = reconcile(seeds, null);
    return base.length === entries.length && base.every((e, i) => e.key === entries[i].key
      && e.width === entries[i].width && !entries[i].hidden);
  }, [entries, seedSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    entries, visible, hidden, customising, setCustomising,
    move, nudge, resize, toggleHidden, reset, commit, isDefault,
  };
}
