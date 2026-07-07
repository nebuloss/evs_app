import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccounts, type Account } from '@/store/config'
import { evsClient, isSessionExpired, type StudentProfile, type Lesson, type CreditProvision } from '@/api/evs'
import AccountModal from '@/components/AccountModal'
import { Trash2, Plus, LogIn } from 'lucide-react'
import { useEscapeKey, useEnterKey } from '@/hooks/useKeyShortcuts'

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

function LoadingRows() {
  return (
    <div className="space-y-2 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i} className="h-10 bg-slate-100 dark:bg-slate-700 rounded-lg" />
      ))}
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">{message}</div>
  )
}

/**
 * Renders a query error. An expired session (401 that couldn't be renewed with the
 * stored password) gets an actionable "sign in again" prompt instead of a raw error,
 * mirroring how the real EVS site asks you to re-authenticate.
 */
function SectionError({ error, onReauth }: { error: unknown; onReauth: () => void }) {
  if (isSessionExpired(error)) {
    return (
      <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-4 space-y-3">
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Your session has expired. Please sign in again to view your account.
        </p>
        <button
          onClick={onReauth}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-3 py-2 transition-colors"
        >
          <LogIn size={14} />
          Sign in again
        </button>
      </div>
    )
  }
  return <ErrorBox message={(error as Error).message} />
}

async function withAuth<T>(account: Account, fn: () => Promise<T>): Promise<T> {
  evsClient.loadAccountTokens(account.name)
  // Always remembers credentials so the request layer can self-heal a server-side
  // 401, and eagerly re-signs-in when the token is locally expired.
  await evsClient.ensureAuth(account.email, account.password)
  return fn()
}

function ProfileSection({ account, onReauth }: { account: Account; onReauth: () => void }) {
  const { data, isLoading, error } = useQuery<StudentProfile>({
    queryKey: ['profile', account.name, account.studentId],
    queryFn: () => withAuth(account, () => evsClient.getStudentProfile(account.studentId!)),
    staleTime: 5 * 60_000,
    enabled: !!account.studentId,
    // Don't retry a genuine session-expiry — it just re-hammers sign-in with a
    // password EVS already rejected. Show the "sign in again" prompt immediately.
    retry: (count, err) => !isSessionExpired(err) && count < 3,
  })

  if (isLoading) return <LoadingRows />
  if (error) return <SectionError error={error} onReauth={onReauth} />
  if (!data) return <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">No profile data.</p>

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xl font-bold text-slate-900 dark:text-slate-100">{data.firstName} {data.lastName}</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">{data.email}</p>
          {data.phone && <p className="text-sm text-slate-500 dark:text-slate-400">{data.phone}</p>}
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">{data.credits}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">credits</p>
        </div>
      </div>
      {data.cdrStatus && (
        <p className="text-xs text-slate-400 dark:text-slate-500">CDR status: {data.cdrStatus}</p>
      )}
    </div>
  )
}

function LessonCard({ lesson }: { lesson: Lesson }) {
  const start = new Date(lesson.startsAt)
  const dateStr = start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const startTime = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const end = new Date(lesson.endsAt)
  const endTime = end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  const statusColor: Record<string, string> = {
    confirmed: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
    pending: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
    cancelled: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  }
  const colorClass = statusColor[lesson.status] ?? 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400'

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="font-medium text-slate-900 dark:text-slate-100 capitalize">{dateStr}</p>
        <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${colorClass}`}>
          {lesson.status}
        </span>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {startTime} – {endTime}
        <span className="ml-2 text-slate-400 dark:text-slate-500">({lesson.durationMinutes} min)</span>
        {lesson.automatic && <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">Auto</span>}
      </p>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        👨‍🏫 {lesson.teacher.firstName} {lesson.teacher.lastName}
        {lesson.teacher.carBrand && (
          <span className="text-slate-400 dark:text-slate-500 ml-2 text-xs">{lesson.teacher.carBrand} {lesson.teacher.carModel}</span>
        )}
      </p>
      {lesson.departurePoint && (
        <p className="text-sm text-slate-500 dark:text-slate-400">📍 {lesson.departurePoint.name}, {lesson.departurePoint.city}</p>
      )}
      <p className="text-xs text-slate-400 dark:text-slate-500">{lesson.credits} credit(s)</p>
    </div>
  )
}

function LessonsSection({ account, onReauth }: { account: Account; onReauth: () => void }) {
  const { data, isLoading, error } = useQuery<Lesson[]>({
    queryKey: ['lessons', account.name, account.studentId],
    queryFn: () => withAuth(account, () => evsClient.getLessons(account.studentId!)),
    staleTime: 2 * 60_000,
    enabled: !!account.studentId,
    retry: (count, err) => !isSessionExpired(err) && count < 3,
  })

  if (isLoading) return <LoadingRows />
  if (error) return <SectionError error={error} onReauth={onReauth} />

  const upcoming = (data ?? []).filter(l => l.status !== 'cancelled' && new Date(l.startsAt) > new Date())
  const past = (data ?? []).filter(l => l.status === 'cancelled' || new Date(l.startsAt) <= new Date())

  return (
    <div className="space-y-4">
      {upcoming.length === 0 && past.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">No lessons found.</p>
      )}
      {upcoming.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Upcoming</h3>
          {upcoming.map(l => <LessonCard key={l.id} lesson={l} />)}
        </div>
      )}
      {past.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Past / Cancelled</h3>
          {past.slice(0, 5).map(l => <LessonCard key={l.id} lesson={l} />)}
          {past.length > 5 && (
            <p className="text-xs text-slate-400 dark:text-slate-500 text-center">+{past.length - 5} more</p>
          )}
        </div>
      )}
    </div>
  )
}

function CreditsSection({ account, onReauth }: { account: Account; onReauth: () => void }) {
  const { data, isLoading, error } = useQuery<CreditProvision[]>({
    queryKey: ['credits', account.name, account.studentId],
    queryFn: () => withAuth(account, () => evsClient.getCreditsHistory(account.studentId!)),
    staleTime: 5 * 60_000,
    enabled: !!account.studentId,
    retry: (count, err) => !isSessionExpired(err) && count < 3,
  })

  if (isLoading) return <LoadingRows />
  if (error) return <SectionError error={error} onReauth={onReauth} />
  if (!data || data.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">No credit history.</p>
  }

  return (
    <div className="space-y-3">
      {data.map((p, i) => (
        <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-slate-900 dark:text-slate-100">{p.name}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                {new Date(p.providedAt).toLocaleDateString('fr-FR')}
                {p.discountPrice ? ` · ${p.discountPrice} (was ${p.price})` : ` · ${p.price}`}
              </p>
            </div>
            <div className="text-right">
              <p className="font-bold text-indigo-600 dark:text-indigo-400">{p.remainingCredits}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">remaining</p>
            </div>
          </div>
          {p.expiries.length > 0 && (
            <div className="mt-2 space-y-1">
              {p.expiries.map((e, j) => (
                <p key={j} className="text-xs text-slate-500 dark:text-slate-400">
                  {e.amount} × {e.creditType} · expires {new Date(e.expiresAt).toLocaleDateString('fr-FR')}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default function AccountPage() {
  const { activeAccount, removeAccount, addAccount } = useAccounts()
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  // Re-auth modal, opened from a "session expired" prompt. Prefilled with the active
  // account so the user just confirms/updates their password to get a fresh session.
  const [reauthOpen, setReauthOpen] = useState(false)
  const closeModals = useCallback(() => { setConfirmDelete(false); setAccountModalOpen(false); setReauthOpen(false) }, [])
  const confirmRemove = useCallback(() => {
    if (!confirmDelete || !activeAccount) return
    removeAccount(activeAccount.name)
    setConfirmDelete(false)
  }, [confirmDelete, activeAccount, removeAccount])
  useEscapeKey(closeModals)
  useEnterKey(confirmRemove)

  const saveAccount = (a: Account) => {
    addAccount(a)
    evsClient.loadAccountTokens(a.name)
    setAccountModalOpen(false)
  }

  // Re-authentication succeeded (AccountEditor re-signs-in and returns a fresh
  // studentId/tokens): persist the updated account and refetch everything.
  const saveReauth = (a: Account) => {
    addAccount(a)
    evsClient.loadAccountTokens(a.name)
    setReauthOpen(false)
    queryClient.invalidateQueries({ queryKey: ['profile', a.name] })
    queryClient.invalidateQueries({ queryKey: ['lessons', a.name] })
    queryClient.invalidateQueries({ queryKey: ['credits', a.name] })
  }

  if (!activeAccount) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-center space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-full bg-slate-100 dark:bg-slate-700 p-5">
            <Plus size={28} className="text-slate-400 dark:text-slate-500" />
          </div>
          <div>
            <p className="text-lg font-semibold text-slate-800 dark:text-slate-200">No account yet</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Add an account to view your profile, lessons and credits.</p>
          </div>
        </div>
        <button
          onClick={() => setAccountModalOpen(true)}
          className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-6 py-3 transition-colors"
        >
          Add account
        </button>
        {accountModalOpen && (
          <AccountModal onSave={saveAccount} onClose={() => setAccountModalOpen(false)} />
        )}
      </div>
    )
  }

  const { name, email, anonymous } = activeAccount

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">{name}</h1>
          {anonymous && (
            <span className="text-xs rounded-full px-2 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">anonymous</span>
          )}
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{email}</p>
        {!activeAccount.studentId && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">This account has not been signed in yet.</p>
        )}
      </div>

      <Section title="👤 Profile">
        <ProfileSection account={activeAccount} onReauth={() => setReauthOpen(true)} />
      </Section>

      <Section title="📅 Lessons">
        <LessonsSection account={activeAccount} onReauth={() => setReauthOpen(true)} />
      </Section>

      <Section title="💳 Credits">
        <CreditsSection account={activeAccount} onReauth={() => setReauthOpen(true)} />
      </Section>

      {reauthOpen && (
        <AccountModal
          title="Sign in again"
          initial={activeAccount}
          onSave={saveReauth}
          onClose={() => setReauthOpen(false)}
        />
      )}

      {/* Remove account */}
      <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-red-800 dark:text-red-300">Remove this account</p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">Deletes saved credentials and tokens from your browser.</p>
          </div>
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
          >
            <Trash2 size={14} />
            Remove
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setConfirmDelete(false)} />
          <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-red-100 dark:bg-red-900/40 p-2.5 shrink-0">
                <Trash2 size={18} className="text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="font-semibold text-slate-900 dark:text-slate-100">Remove account?</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                  <span className="font-medium text-slate-700 dark:text-slate-300">{name}</span> and its saved tokens will be deleted.
                </p>
              </div>
            </div>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 rounded-xl border border-slate-200 dark:border-slate-600 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRemove}
                className="flex-1 rounded-xl bg-red-600 hover:bg-red-700 py-2.5 text-sm font-semibold text-white transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
