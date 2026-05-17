import { Heart, HeartOff, MapPin, Timer, CreditCard, X } from 'lucide-react'
import { useEscapeKey, useEnterKey } from '@/hooks/useKeyShortcuts'
import type { Slot } from '@/core/snapshot'
import { cn } from '@/lib/utils'

interface Props {
  slot: Slot
  dateLabel: string
  wishlisted: boolean
  onAdd: () => void
  onRemove: () => void
  onClose: () => void
  onShowMap: () => void
}

export default function WishlistSlotModal({ slot, dateLabel, wishlisted, onAdd, onRemove, onClose, onShowMap }: Props) {
  useEscapeKey(onClose)
  // Enter triggers the primary action: add if not yet wishlisted, close if already saved.
  useEnterKey(wishlisted ? onClose : () => { onAdd(); onClose() })

  const start = new Date(slot.startsAtLocal)
  const startTime = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const endTime = new Date(start.getTime() + slot.durationMinutes * 60_000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const credits = slot.durationMinutes / 60

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-sm mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
          <p className="font-semibold text-slate-900 dark:text-slate-100 capitalize">{dateLabel}</p>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Slot info */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{startTime}</span>
            <span className="text-slate-400 dark:text-slate-500">→</span>
            <span className="text-xl font-semibold tabular-nums text-slate-700 dark:text-slate-300">{endTime}</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1">
              <Timer size={12} className="text-slate-400 dark:text-slate-500" />
              {slot.durationMinutes} min
            </span>
            <span className="flex items-center gap-1">
              <CreditCard size={12} className="text-slate-400 dark:text-slate-500" />
              {Number.isInteger(credits) ? credits : credits.toFixed(1)} credit{credits !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
            <p className="font-medium text-slate-800 dark:text-slate-200">
              {slot.teacherName}
              {slot.teacherRating > 0 && (
                <span className="ml-2 text-xs font-normal text-amber-500">
                  {'★'.repeat(Math.round(slot.teacherRating))} {slot.teacherRating.toFixed(1)}
                </span>
              )}
            </p>
            <button
              onClick={onShowMap}
              className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
            >
              <MapPin size={13} />
              {slot.locationName}
            </button>
          </div>

          {wishlisted && (
            <p className="text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg px-3 py-2">
              Already saved to your wishlist.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className={cn('grid gap-2 px-5 pb-5', wishlisted ? 'grid-cols-2' : 'grid-cols-1')}>
          {wishlisted ? (
            <>
              <button
                onClick={() => { onRemove(); onClose() }}
                className="flex items-center justify-center gap-2 rounded-xl border border-red-200 dark:border-red-800 py-2.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                <HeartOff size={15} />
                Remove
              </button>
              <button
                onClick={onClose}
                className="rounded-xl bg-slate-100 dark:bg-slate-700 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                Close
              </button>
            </>
          ) : (
            <button
              onClick={() => { onAdd(); onClose() }}
              className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 py-3 text-sm font-semibold text-white transition-colors"
            >
              <Heart size={15} />
              Save to wishlist
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
