import { useState } from 'react'
import type { TimeProfile, TimeWindow } from '@/store/config'
import { cn } from '@/lib/utils'

const DAYS = [
  { label: 'Mon', iso: 1 },
  { label: 'Tue', iso: 2 },
  { label: 'Wed', iso: 3 },
  { label: 'Thu', iso: 4 },
  { label: 'Fri', iso: 5 },
  { label: 'Sat', iso: 6 },
  { label: 'Sun', iso: 7 },
]

interface Props {
  initial?: TimeProfile
  onSave: (t: TimeProfile) => void
  onCancel?: () => void
}

export default function TimeEditor({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [])
  const [windows, setWindows] = useState<TimeWindow[]>(
    initial?.windows ?? [{ start: '08:00', end: '18:00' }],
  )
  const [anyTime, setAnyTime] = useState(!initial?.windows?.length)

  const toggleDay = (iso: number) =>
    setWeekdays(prev =>
      prev.includes(iso) ? prev.filter(d => d !== iso) : [...prev, iso].sort((a, b) => a - b),
    )

  const updateWindow = (i: number, field: 'start' | 'end', val: string) =>
    setWindows(prev => prev.map((w, idx) => (idx === i ? { ...w, [field]: val } : w)))

  const addWindow = () => setWindows(prev => [...prev, { start: '08:00', end: '18:00' }])

  const removeWindow = (i: number) => setWindows(prev => prev.filter((_, idx) => idx !== i))

  const handleSave = () => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      weekdays,
      windows: anyTime ? [] : windows,
    })
  }

  return (
    <form onSubmit={e => { e.preventDefault(); handleSave() }} className="space-y-5">
      {/* Name */}
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Profile name</label>
        <input
          className="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="e.g. Weekday mornings"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>

      {/* Weekday selector */}
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Days <span className="text-slate-400 dark:text-slate-500 font-normal">(none = any day)</span>
        </label>
        <div className="flex gap-1.5">
          {DAYS.map(d => (
            <button
              key={d.iso}
              type="button"
              onClick={() => toggleDay(d.iso)}
              className={cn(
                'flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors',
                weekdays.includes(d.iso)
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600 hover:border-indigo-300 dark:hover:border-indigo-600',
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Time windows */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Time windows</label>
          <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={anyTime}
              onChange={e => setAnyTime(e.target.checked)}
              className="accent-indigo-600"
            />
            Any time
          </label>
        </div>

        {!anyTime && (
          <div className="space-y-2">
            {windows.map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="time"
                  value={w.start}
                  onChange={e => updateWindow(i, 'start', e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-2 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <span className="text-slate-400 dark:text-slate-500 text-sm">→</span>
                <input
                  type="time"
                  value={w.end}
                  onChange={e => updateWindow(i, 'end', e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-2 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                {windows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeWindow(i)}
                    className="text-slate-400 dark:text-slate-500 hover:text-red-500 text-lg leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addWindow}
              className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
            >
              + Add window
            </button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!name.trim()}
          className={cn(
            'flex-1 rounded-lg py-2 text-sm font-semibold text-white transition-colors',
            name.trim()
              ? 'bg-indigo-600 hover:bg-indigo-700'
              : 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed',
          )}
        >
          Save time profile
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 rounded-lg py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
