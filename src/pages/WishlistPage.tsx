import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import SlotCard from '@/components/SlotCard'
import BookingModal from '@/components/BookingModal'
import { useWishlist, useAccounts, wishlistKey } from '@/store/config'
import { evsClient, isSessionExpired, type StudentProfile } from '@/api/evs'
import type { Slot } from '@/core/snapshot'
import { cn } from '@/lib/utils'

export default function WishlistPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { items, remove, removeWhere } = useWishlist()
  const { activeAccount } = useAccounts()
  const studentId = activeAccount?.studentId ?? null

  const [bookingSlot, setBookingSlot] = useState<Slot | null>(null)
  const [booking, setBooking] = useState(false)
  const [bookingError, setBookingError] = useState<string | null>(null)
  const [successSlotKey, setSuccessSlotKey] = useState<string | null>(null)

  const { data: profile } = useQuery<StudentProfile>({
    queryKey: ['profile', activeAccount?.name, studentId],
    queryFn: async () => {
      // Must load the right account's tokens before each request. ensureAuth also
      // remembers credentials so a server-side 401 self-heals transparently.
      evsClient.loadAccountTokens(activeAccount!.name)
      await evsClient.ensureAuth(activeAccount!.email, activeAccount!.password)
      return evsClient.getStudentProfile(studentId!)
    },
    enabled: !!studentId && !!activeAccount,
    staleTime: 2 * 60_000,
    retry: (count, err) => !isSessionExpired(err) && count < 3,
  })

  const credits = profile?.credits ?? 0

  const sorted = [...items].sort((a, b) =>
    a.startsAtUtc.localeCompare(b.startsAtUtc) || a.durationMinutes - b.durationMinutes)
  // A slot is outdated once its lesson start time has passed. Compare against
  // startsAtUtc (always a valid UTC instant), independent of the viewer's tz.
  const now = Date.now()
  const isExpired = (s: Slot) => new Date(s.startsAtUtc).getTime() <= now
  const upcoming = sorted.filter(s => !isExpired(s))
  const expired = sorted.filter(isExpired)
  // Re-evaluate freshly at click time so a slot that expired since render is caught.
  const clearExpired = () => removeWhere(s => new Date(s.startsAtUtc).getTime() <= Date.now())

  const handleBook = (slot: Slot) => {
    setBookingSlot(slot)
    setBookingError(null)
  }

  const handleConfirm = async () => {
    if (!bookingSlot || !activeAccount) return
    setBooking(true)
    setBookingError(null)
    try {
      evsClient.loadAccountTokens(activeAccount.name)
      await evsClient.ensureAuth(activeAccount.email, activeAccount.password)
      await evsClient.bookLesson(bookingSlot)
      const key = wishlistKey(bookingSlot)
      remove(key)
      setSuccessSlotKey(key)
      setBookingSlot(null)
      queryClient.invalidateQueries({ queryKey: ['profile', activeAccount.name, studentId] })
    } catch (err) {
      setBookingError((err as Error).message)
    } finally {
      setBooking(false)
    }
  }

  // The wishlist is always viewable, even with no real account configured
  // (e.g. anonymous browsing). Only *booking* requires a real, credited account,
  // which is gated separately by the disabled "Book" button and handleConfirm.

  // Renders one wishlist row. Expired slots are dimmed, flagged, and not bookable.
  const renderSlotRow = (slot: Slot, expiredFlag: boolean) => {
    const key = wishlistKey(slot)
    const canBook = credits > 0 && !!studentId
    return (
      <div key={key} className={cn('relative', expiredFlag && 'opacity-50 grayscale')}>
        {expiredFlag && (
          <span className="absolute right-3 top-3 z-10 rounded-full bg-slate-200 dark:bg-slate-700 px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            Expired
          </span>
        )}
        <SlotCard slot={slot} />
        <div className="flex gap-2 px-4 pb-4 -mt-1">
          <button
            onClick={() => remove(key)}
            className="flex-1 rounded-lg py-2 text-sm font-medium text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-800 transition-colors"
          >
            Remove
          </button>
          {!expiredFlag && (
            <button
              onClick={() => handleBook(slot)}
              disabled={!canBook}
              title={credits === 0 ? 'No credits available' : undefined}
              className={cn(
                'flex-1 rounded-lg py-2 text-sm font-semibold transition-colors',
                canBook
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed',
              )}
            >
              {credits === 0 ? 'No credits' : 'Book'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Wishlist</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {upcoming.length} upcoming{expired.length > 0 && ` · ${expired.length} expired`}
            {profile && (
              <span className="ml-2 text-indigo-600 dark:text-indigo-400 font-medium">{credits} credit(s) available</span>
            )}
          </p>
        </div>
      </div>

      {successSlotKey && (
        <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-4 text-sm text-emerald-700 dark:text-emerald-400 font-medium">
          ✓ Lesson booked successfully!
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-12 text-center space-y-3">
          <p className="text-slate-500 dark:text-slate-400">No slots in your wishlist yet.</p>
          <button
            onClick={() => navigate('/query')}
            className="text-indigo-600 dark:text-indigo-400 font-medium hover:underline text-sm"
          >
            Search for slots →
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 && (
            <div className="space-y-4">
              {upcoming.map(slot => renderSlotRow(slot, false))}
            </div>
          )}

          {expired.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Expired ({expired.length})
                </h2>
                <button
                  onClick={clearExpired}
                  className="text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
                >
                  Clear expired
                </button>
              </div>
              <div className="space-y-4">
                {expired.map(slot => renderSlotRow(slot, true))}
              </div>
            </div>
          )}
        </div>
      )}

      {bookingSlot && (
        <BookingModal
          slot={bookingSlot}
          onConfirm={handleConfirm}
          onCancel={() => { setBookingSlot(null); setBookingError(null) }}
          booking={booking}
          error={bookingError}
        />
      )}
    </div>
  )
}
