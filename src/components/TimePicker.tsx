import type { TimeProfile } from '@/store/config'
import { cn } from '@/lib/utils'

const DAYS_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function describeTime(t: TimeProfile): string {
  const days = t.weekdays.length ? t.weekdays.map(d => DAYS_SHORT[d]).join(', ') : 'Any day'
  const wins = t.windows.length
    ? t.windows.map(w => `${w.start}–${w.end}`).join(', ')
    : 'Any time'
  return `${days} · ${wins}`
}

interface Props {
  times: TimeProfile[]
  selected: TimeProfile | null
  onChange: (t: TimeProfile) => void
  onAddNew?: () => void
}

export default function TimePicker({ times, selected, onChange, onAddNew }: Props) {
  if (times.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No time profiles saved.{' '}
        {onAddNew && (
          <button onClick={onAddNew} className="text-indigo-600 dark:text-indigo-400 font-medium hover:underline">
            Add one
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {times.map(t => (
        <button
          key={t.name}
          onClick={() => onChange(t)}
          className={cn(
            'flex flex-col items-start rounded-xl border px-4 py-2.5 text-sm font-medium transition-all',
            selected?.name === t.name
              ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 shadow-sm ring-1 ring-indigo-400'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20',
          )}
        >
          <span>🕐 {t.name}</span>
          <span className="text-xs text-slate-400 dark:text-slate-500 font-normal mt-0.5">{describeTime(t)}</span>
        </button>
      ))}
      {onAddNew && (
        <button
          onClick={onAddNew}
          className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 px-4 py-2.5 text-sm text-slate-500 dark:text-slate-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:border-indigo-600 dark:hover:text-indigo-400 transition-colors"
        >
          + Add time
        </button>
      )}
    </div>
  )
}
