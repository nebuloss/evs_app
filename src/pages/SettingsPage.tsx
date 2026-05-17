import { useState } from 'react'
import PlaceModal from '@/components/PlaceModal'
import TimeModal from '@/components/TimeModal'
import { usePlaces, useTimes, type PlaceProfile, type TimeProfile } from '@/store/config'
import { cn } from '@/lib/utils'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/50">
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </section>
  )
}

export default function SettingsPage() {
  const { places, addPlace, removePlace } = usePlaces()
  const { times, addTime, removeTime } = useTimes()

  const [placeModal, setPlaceModal] = useState<{ open: boolean; editing?: PlaceProfile }>({ open: false })
  const [timeModal, setTimeModal] = useState<{ open: boolean; editing?: TimeProfile }>({ open: false })

  const savePlace = (p: PlaceProfile) => { addPlace(p); setPlaceModal({ open: false }) }
  const saveTime = (t: TimeProfile) => { addTime(t); setTimeModal({ open: false }) }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">All data is stored in your browser only.</p>
      </div>

      {/* Places */}
      <Section title="📍 Places">
        <div className="space-y-4">
          {places.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">No places saved yet.</p>
          )}

          {places.map(p => (
            <div
              key={p.name}
              className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-3"
            >
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{p.name}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {p.lat.toFixed(4)}, {p.lng.toFixed(4)} · {p.radius_km} km
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPlaceModal({ open: true, editing: p })}
                  className="text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 px-2 py-1 rounded hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                >
                  Edit
                </button>
                <button
                  onClick={() => removePlace(p.name)}
                  className="text-xs text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={() => setPlaceModal({ open: true })}
            className={cn(
              'w-full rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-600 py-3 text-sm text-slate-500 dark:text-slate-400',
              'hover:border-indigo-400 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:text-indigo-400 transition-colors',
            )}
          >
            + Add place
          </button>
        </div>
      </Section>

      {/* Times */}
      <Section title="🕐 Time profiles">
        <div className="space-y-4">
          {times.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">No time profiles saved yet.</p>
          )}

          {times.map(t => (
            <div
              key={t.name}
              className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-3"
            >
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{t.name}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {t.weekdays.length ? `Days: ${t.weekdays.join(', ')}` : 'Any day'}
                  {t.windows.length
                    ? ` · ${t.windows.map(w => `${w.start}–${w.end}`).join(', ')}`
                    : ' · Any time'}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setTimeModal({ open: true, editing: t })}
                  className="text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 px-2 py-1 rounded hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                >
                  Edit
                </button>
                <button
                  onClick={() => removeTime(t.name)}
                  className="text-xs text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={() => setTimeModal({ open: true })}
            className={cn(
              'w-full rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-600 py-3 text-sm text-slate-500 dark:text-slate-400',
              'hover:border-indigo-400 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:text-indigo-400 transition-colors',
            )}
          >
            + Add time profile
          </button>
        </div>
      </Section>

      {/* Modals */}
      {placeModal.open && (
        <PlaceModal
          initial={placeModal.editing}
          onSave={savePlace}
          onClose={() => setPlaceModal({ open: false })}
        />
      )}
      {timeModal.open && (
        <TimeModal
          initial={timeModal.editing}
          onSave={saveTime}
          onClose={() => setTimeModal({ open: false })}
        />
      )}
    </div>
  )
}
