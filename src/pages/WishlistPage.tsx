import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import SlotCard from '@/components/SlotCard'
import BookingModal from '@/components/BookingModal'
import { useWishlist, useAccounts, wishlistKey } from '@/store/config'
import { evsClient, type StudentProfile } from '@/api/evs'
import type { Slot } from '@/core/snapshot'
import { cn } from '@/lib/utils'

export default function WishlistPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { items, remove } = useWishlist()
  const { activeAccount } = useAccounts()
  const studentId = activeAccount?.studentId ?? null

  const [bookingSlot, setBookingSlot] = useState<Slot | null>(null)
  const [booking, setBooking] = useState(false)
  const [bookingError, setBookingError] = useState<string | null>(null)
  const [successSlotKey, setSuccessSlotKey] = useState<string | null>(null)

  const { data: profile } = useQuery<StudentProfile>({
    queryKey: ['profile', activeAccount?.name, studentId],
    queryFn: async () => {
      // Must load the right account's tokens before each request.
      evsClient.loadAccountTokens(activeAccount!.name)
      if (evsClient.isExpired()) await evsClient.signIn(activeAccount!.email, activeAccount!.password)
      return evsClient.getStudentProfile(studentId!)
    },
    enabled: !!studentId && !!activeAccount,
    staleTime: 2 * 60_000,
  })

  const credits = profile?.credits ?? 0

  const sorted = [...items].sort((a, b) =>
    a.startsAtUtc.localeCompare(b.startsAtUtc) || a.durationMinutes - b.durationMinutes)

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

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Wishlist</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {items.length} slot(s) saved
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
        <div className="space-y-4">
          {sorted.map(slot => {
            const key = wishlistKey(slot)
            const canBook = credits > 0 && !!studentId
            return (
              <div key={key} className="relative">
                <SlotCard slot={slot} />
                <div className="flex gap-2 px-4 pb-4 -mt-1">
                  <button
                    onClick={() => remove(key)}
                    className="flex-1 rounded-lg py-2 text-sm font-medium text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-800 transition-colors"
                  >
                    Remove
                  </button>
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
                </div>
              </div>
            )
          })}
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
