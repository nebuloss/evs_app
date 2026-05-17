import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { Slot } from '@/core/snapshot'
import type { PlaceProfile, TimeProfile } from '@/store/config'
import type { Gearbox } from '@/core/search'

export interface QueryState {
  place: PlaceProfile | null
  time: TimeProfile | null
  gearbox: Gearbox
  minRating: number
  /** Null means no query has been run yet; empty array means query ran but returned nothing. */
  results: Slot[] | null
  snapshotInfo: { slots: number; fetchedAt: string | null } | null
  error: string | null
  /** Number of day-groups currently rendered (pagination). */
  visibleDays: number
}

const defaultState: QueryState = {
  place: null,
  time: null,
  gearbox: 'bvm',
  minRating: 0,
  results: null,
  snapshotInfo: null,
  error: null,
  visibleDays: 5,
}

interface QueryStateCtx {
  state: QueryState
  /** Merges a partial update into the current state (like setState in class components). */
  setState: (patch: Partial<QueryState>) => void
  /** Resets results, error, and snapshotInfo while preserving filter selections. */
  resetResults: () => void
}

const Ctx = createContext<QueryStateCtx | null>(null)

export function QueryStateProvider({ children }: { children: ReactNode }) {
  const [state, setStateFull] = useState<QueryState>(defaultState)

  // Memoized so consumers that depend on setState (e.g. runQuery useCallback) don't
  // get a new reference on every render, which would invalidate their memoisation.
  const setState = useCallback(
    (patch: Partial<QueryState>) => setStateFull(prev => ({ ...prev, ...patch })),
    [],
  )

  const resetResults = useCallback(
    () => setStateFull(prev => ({ ...prev, results: null, snapshotInfo: null, error: null, visibleDays: 5 })),
    [],
  )

  return <Ctx.Provider value={{ state, setState, resetResults }}>{children}</Ctx.Provider>
}

export function useQueryState(): QueryStateCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useQueryState must be inside QueryStateProvider')
  return ctx
}
