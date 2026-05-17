import type { Slot } from '@/core/snapshot'
import { cn } from '@/lib/utils'
import { useEscapeKey, useEnterKey } from '@/hooks/useKeyShortcuts'

interface Props {
  slot: Slot
  onConfirm: () => void
  onCancel: () => void
  booking: boolean
  error: string | null
}

export default function BookingModal({ slot, onConfirm, onCancel, booking, error }: Props) {
  useEscapeKey(onCancel, !booking)
  useEnterKey(onConfirm, !booking)
  const start = new Date(slot.startsAtLocal)
  const dateStr = start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const startTime = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const endMs = start.getTime() + slot.durationMinutes * 60_000
  const endTime = new Date(endMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={!booking ? onCancel : undefined}
      />

      {/* Modal */}
      <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 space-y-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Confirm booking</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Review the details before confirming.</p>
        </div>

        {/* Slot details */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-slate-900 dark:text-slate-100">{slot.teacherName}</p>
            <span className="text-xs bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 rounded-full px-2 py-0.5">
              {slot.gearboxType === 'bva' ? 'Auto' : 'Manual'}
            </span>
          </div>
          <p className="text-slate-600 dark:text-slate-300">
            <span className="text-amber-400">{'★'.repeat(Math.round(slot.teacherRating))}</span>
            <span className="ml-1 text-slate-400 dark:text-slate-500 text-xs">{slot.teacherRating.toFixed(1)}</span>
          </p>
          <p className="text-slate-600 dark:text-slate-300">📍 {slot.locationName}</p>
          <p className="text-slate-600 dark:text-slate-300">📅 <span className="capitalize">{dateStr}</span></p>
          <p className="text-slate-600 dark:text-slate-300">🕐 {startTime} – {endTime} <span className="text-slate-400 dark:text-slate-500">({slot.durationMinutes} min)</span></p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={booking}
            className="flex-1 rounded-xl py-2.5 text-sm font-semibold border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={booking}
            className={cn(
              'flex-1 rounded-xl py-2.5 text-sm font-semibold text-white transition-colors',
              booking ? 'bg-indigo-400 cursor-wait' : 'bg-indigo-600 hover:bg-indigo-700',
            )}
          >
            {booking ? 'Booking…' : 'Confirm booking'}
          </button>
        </div>
      </div>
    </div>
  )
}
