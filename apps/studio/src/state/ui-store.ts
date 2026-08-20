/**
 * Ephemeral UI state — Zustand. One store, sliced.
 *
 * ═══ THE SPLIT, AND WHY (UI §4.1) ═══
 *
 * TanStack Query holds SERVER state: orgs, members, invitations, projects, surveys, versions,
 * jobs. It has a URL, an owner, a staleness model and a revision. Anything that models it as
 * local state has to reinvent caching, deduplication, retry, invalidation and offline-window
 * behaviour — and in this product "stale" means "the programmer edited a rule that no longer
 * exists", which has a data-loss shape.
 *
 * Zustand holds state with NO server representation: selection, tree expansion, filter text,
 * pane sizes, the active bottom tab, Simple/Advanced mode, annotation density, and (from P1-03)
 * the undo stack and mutation queue. It is ephemeral, synchronous, and read by many components
 * at once: `useState` would mean prop-drilling through the shell, and Context would re-render
 * the whole editor on every keystroke.
 *
 * THE RULE: no server data in this store. Not "prefer not to" — none. A copy of a project row
 * here is a second source of truth with no staleness model, and the first symptom is a rename
 * that reappears after a refetch. The store below therefore holds ids and view flags only, and
 * `selectedNodeId` is here rather than in the URL only until P1-03 makes node selection a
 * route (which it should be: back/forward and shareable links come free).
 */

'use client';

import { create } from 'zustand';

export type ThemeSetting = 'light' | 'dark' | 'system';
export type EditorMode = 'simple' | 'advanced';
export type BottomTab = 'properties' | 'logic' | 'validation' | 'code' | 'problems' | 'preview';

export interface UiState {
  /* --- shell layout (UI §1.2) ------------------------------------------- */
  railCollapsed: boolean;
  /** Collapse is a DISTINCT state from "dragged to minimum": it restores the previous size. */
  railWidth: number;
  bottomTab: BottomTab;
  theme: ThemeSetting;
  /** UI §11's `comfortable` density preference. Compact is the default for a professional tool. */
  density: 'compact' | 'comfortable';

  /* --- editor selection (a route from P1-03; local for now) -------------- */
  selectedNodeId: string | null;
  treeFilter: string;
  expandedNodeIds: ReadonlySet<string>;

  /* --- transient chrome -------------------------------------------------- */
  commandPaletteOpen: boolean;

  toggleRail: () => void;
  setRailWidth: (width: number) => void;
  setBottomTab: (tab: BottomTab) => void;
  setTheme: (theme: ThemeSetting) => void;
  setDensity: (density: 'compact' | 'comfortable') => void;
  selectNode: (nodeId: string | null) => void;
  setTreeFilter: (filter: string) => void;
  toggleExpanded: (nodeId: string) => void;
  setCommandPaletteOpen: (open: boolean) => void;
}

const MIN_RAIL = 200;
const MAX_RAIL = 520;

export const useUiStore = create<UiState>((set) => ({
  railCollapsed: false,
  railWidth: 220,
  bottomTab: 'properties',
  theme: 'system',
  density: 'compact',
  selectedNodeId: null,
  treeFilter: '',
  expandedNodeIds: new Set<string>(),
  commandPaletteOpen: false,

  toggleRail: () => set((state) => ({ railCollapsed: !state.railCollapsed })),
  setRailWidth: (width) => set({ railWidth: Math.min(MAX_RAIL, Math.max(MIN_RAIL, width)) }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
  setTheme: (theme) => set({ theme }),
  setDensity: (density) => set({ density }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  setTreeFilter: (treeFilter) => set({ treeFilter }),
  toggleExpanded: (nodeId) =>
    set((state) => {
      const next = new Set(state.expandedNodeIds);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { expandedNodeIds: next };
    }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
}));
