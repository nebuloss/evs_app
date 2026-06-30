import type { Slot } from '@/core/snapshot'

interface Props {
  slot: Slot
}

function Stars({ rating }: { rating: number }) {
  const full = Math.round(rating)
  return (
    <span className="text-amber-400 text-sm" title={`${rating.toFixed(1)}/5`}>
      {'★'.repeat(full)}{'☆'.repeat(5 - full)}
      <span className="ml-1 text-slate-500 dark:text-slate-400 text-xs">{rating.toFixed(1)}</span>
    </span>
  )
}

export default function SlotCard({ slot }: Props) {
  // Format from startsAtUtc (always a valid UTC ISO) in the browser's full-ICU
  // Europe/Paris — immune to server locale builds and stale startsAtLocal.
  const tz = { timeZone: 'Europe/Paris' } as const
  const start = new Date(slot.startsAtUtc)
  const dateStr = start.toLocaleDateString('fr-FR', { ...tz, weekday: 'short', day: 'numeric', month: 'short' })
  const startTime = start.toLocaleTimeString('fr-FR', { ...tz, hour: '2-digit', minute: '2-digit' })
  const endMs = start.getTime() + slot.durationMinutes * 60_000
  const endTime = new Date(endMs).toLocaleTimeString('fr-FR', { ...tz, hour: '2-digit', minute: '2-digit' })

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-sm transition-all flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-slate-900 dark:text-slate-100">{slot.teacherName}</p>
          <Stars rating={slot.teacherRating} />
        </div>
        <span className="text-xs rounded-full px-2 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 font-medium">
          {slot.gearboxType === 'bva' ? '⚙ Auto' : '⚙ Manual'}
          {slot.teacherAutomaticCar && ' ✓'}
        </span>
      </div>

      <div className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
        <p className="flex items-center gap-1.5">
          <span>📍</span>
          <span>{slot.locationName}</span>
        </p>
        <p className="flex items-center gap-1.5">
          <span>📅</span>
          <span>{dateStr}</span>
          <span className="font-medium text-slate-800 dark:text-slate-200">{startTime} – {endTime}</span>
          <span className="text-slate-400 dark:text-slate-500">({slot.durationMinutes} min)</span>
        </p>
      </div>

    </div>
  )
}
