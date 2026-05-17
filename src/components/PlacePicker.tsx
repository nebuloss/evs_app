import type { PlaceProfile } from '@/store/config'
import { cn } from '@/lib/utils'

interface Props {
  places: PlaceProfile[]
  selected: PlaceProfile | null
  onChange: (p: PlaceProfile) => void
  onAddNew?: () => void
}

export default function PlacePicker({ places, selected, onChange, onAddNew }: Props) {
  if (places.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No places saved.{' '}
        {onAddNew && (
          <button onClick={onAddNew} className="text-indigo-600 dark:text-indigo-400 font-medium hover:underline">
            Add a place
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {places.map(p => (
        <button
          key={p.name}
          onClick={() => onChange(p)}
          className={cn(
            'flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all',
            selected?.name === p.name
              ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 shadow-sm ring-1 ring-indigo-400'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20',
          )}
        >
          <span>📍</span>
          <span>{p.name}</span>
          <span className="text-xs text-slate-400 dark:text-slate-500 font-normal">{p.radius_km} km</span>
        </button>
      ))}
      {onAddNew && (
        <button
          onClick={onAddNew}
          className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 px-4 py-2.5 text-sm text-slate-500 dark:text-slate-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:border-indigo-600 dark:hover:text-indigo-400 transition-colors"
        >
          + Add place
        </button>
      )}
    </div>
  )
}
