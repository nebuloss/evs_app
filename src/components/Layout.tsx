import { useRef, useState, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Search, Heart, User, Settings, ChevronDown, Check, Plus, Trash2, Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccounts, useTheme, useSettings, type Account } from '@/store/config'
import { evsClient } from '@/api/evs'
import AccountModal from '@/components/AccountModal'
import { useEscapeKey, useEnterKey } from '@/hooks/useKeyShortcuts'

const navItems = [
  { to: '/query',    label: 'Search',   Icon: Search },
  { to: '/wishlist', label: 'Wishlist', Icon: Heart  },
  { to: '/account',  label: 'Account',  Icon: User   },
]

// ── Confirm delete modal ───────────────────────────────────────────────────────

function ConfirmDeleteModal({ name, onConfirm, onCancel }: {
  name: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEscapeKey(onCancel)
  useEnterKey(onConfirm)
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-red-100 dark:bg-red-900/40 p-2.5 shrink-0">
            <Trash2 size={18} className="text-red-600 dark:text-red-400" />
          </div>
          <div>
            <p className="font-semibold text-slate-900 dark:text-slate-100">Remove account?</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              <span className="font-medium text-slate-700 dark:text-slate-300">{name}</span> will be deleted.
            </p>
          </div>
        </div>
        <div className="flex gap-3 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-200 dark:border-slate-600 py-3 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-red-600 hover:bg-red-700 py-3 text-sm font-semibold text-white transition-colors"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Theme toggle ──────────────────────────────────────────────────────────────

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      className="flex items-center gap-2 rounded-xl px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark'
        ? <Sun size={18} className="shrink-0" />
        : <Moon size={18} className="shrink-0" />}
      <span className="text-xs font-semibold hidden sm:inline">
        {theme === 'dark' ? 'Light' : 'Dark'}
      </span>
    </button>
  )
}

// ── Settings menu (cache expiration) ───────────────────────────────────────────

function SettingsMenu() {
  const { cacheTtlMin, setCacheTtlMin } = useSettings()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const presets: Array<[string, number]> = [['Off', 0], ['15 min', 15], ['1 h', 60], ['1 day', 1440]]
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)} title="Settings"
        className="rounded-xl px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors">
        <Settings size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl z-50 p-4 text-slate-700 dark:text-slate-200">
          <p className="text-sm font-semibold mb-1">Cache expiration</p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-3">Reuse saved results without re-querying EVS for this long.</p>
          <div className="flex items-center gap-2">
            <input type="number" min={0} value={cacheTtlMin}
              onChange={e => setCacheTtlMin(Number(e.target.value))}
              className="w-24 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-2 py-1.5 text-sm" />
            <span className="text-sm text-slate-500 dark:text-slate-400">minutes</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {presets.map(([l, v]) => (
              <button key={v} onClick={() => setCacheTtlMin(v)}
                className={cn('rounded-lg border px-2.5 py-1 text-xs transition-colors',
                  cacheTtlMin === v ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-slate-200 dark:border-slate-600 hover:border-indigo-400')}>
                {l}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2"><b>0</b> = always fetch fresh from EVS.</p>
        </div>
      )}
    </div>
  )
}

// ── Account switcher ──────────────────────────────────────────────────────────

function AccountSwitcher() {
  const { accounts, activeAccount, setActiveAccount, addAccount, removeAccount } = useAccounts()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Only real (non-anonymous) accounts are shown to the user.
  const realAccounts = accounts.filter(a => !a.anonymous)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSwitch = (name: string) => {
    setActiveAccount(name)
    evsClient.loadAccountTokens(name)
    setOpen(false)
  }

  const handleRemove = (name: string) => {
    setConfirmDelete(name)
    setOpen(false)
  }

  const confirmRemove = () => {
    if (!confirmDelete) return
    removeAccount(confirmDelete)
    setConfirmDelete(null)
  }

  const saveAccount = (a: Account) => {
    addAccount(a)
    evsClient.loadAccountTokens(a.name)
    setAccountModalOpen(false)
    setOpen(false)
  }

  const hasAccounts = realAccounts.length > 0

  return (
    <>
      <div className="relative" ref={ref}>
        {hasAccounts ? (
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-2 rounded-xl px-3 py-2 bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 shrink-0">
              <span className="text-xs font-bold text-white leading-none">
                {activeAccount?.name[0]?.toUpperCase() ?? '?'}
              </span>
            </div>
            {/* Hide account name on very small screens to save topbar space */}
            <span className="hidden xs:inline text-sm font-semibold text-white max-w-28 truncate">
              {activeAccount?.name ?? 'Select'}
            </span>
            <ChevronDown size={14} className={cn('text-slate-400 transition-transform shrink-0', open && 'rotate-180')} />
          </button>
        ) : (
          <button
            onClick={() => setAccountModalOpen(true)}
            className="flex items-center gap-2 rounded-xl px-3 py-2 bg-indigo-600 hover:bg-indigo-500 transition-colors"
          >
            <Plus size={14} className="text-white" />
            <span className="text-sm font-semibold text-white">Add account</span>
          </button>
        )}

        {open && hasAccounts && (
          // Right-align but cap at viewport width so it never overflows on narrow screens
          <div className="absolute right-0 top-full mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl z-20 py-2 overflow-hidden">
            <p className="px-4 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Switch account
            </p>
            {realAccounts.map(a => (
              <div
                key={a.name}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 group',
                  a.name === activeAccount?.name
                    ? 'bg-indigo-50 dark:bg-indigo-900/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700',
                )}
              >
                <button
                  onClick={() => handleSwitch(a.name)}
                  className="flex-1 flex items-center gap-2.5 min-w-0 text-left"
                >
                  <div className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    a.name === activeAccount?.name
                      ? 'bg-indigo-500 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
                  )}>
                    {a.name[0].toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn(
                      'text-sm font-medium truncate',
                      a.name === activeAccount?.name
                        ? 'text-indigo-700 dark:text-indigo-400'
                        : 'text-slate-800 dark:text-slate-200',
                    )}>
                      {a.name}
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                      {a.anonymous ? 'anonymous' : a.email}
                    </p>
                  </div>
                  {a.name === activeAccount?.name && (
                    <Check size={13} className="shrink-0 text-indigo-500" />
                  )}
                </button>
                {/* Always visible on touch devices; hover-only on pointer devices */}
                <button
                  onClick={() => handleRemove(a.name)}
                  className="shrink-0 rounded-lg p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                  title="Remove account"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <div className="mx-4 my-1.5 h-px bg-slate-100 dark:bg-slate-700" />
            <button
              onClick={() => { setOpen(false); setAccountModalOpen(true) }}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors font-medium"
            >
              <Plus size={14} />
              Add account
            </button>
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDeleteModal
          name={confirmDelete}
          onConfirm={confirmRemove}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {accountModalOpen && (
        <AccountModal
          onSave={saveAccount}
          onClose={() => setAccountModalOpen(false)}
        />
      )}
    </>
  )
}

// ── Root layout ───────────────────────────────────────────────────────────────

export default function Layout() {
  return (
    <div className="flex h-screen w-full overflow-hidden">

      {/* Sidebar — desktop only */}
      <nav className="hidden md:flex w-52 shrink-0 bg-slate-900 text-slate-100 flex-col h-full">
        <div className="px-5 py-6 border-b border-slate-700">
          <span className="text-lg font-bold tracking-tight text-white">🚗 EVS</span>
          <p className="text-xs text-slate-400 mt-0.5">Slot finder</p>
        </div>
        <ul className="flex-1 py-4 space-y-1 px-2">
          {navItems.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) => cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                )}
              >
                <Icon size={16} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content column */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Topbar */}
        <header className="bg-slate-900 border-b border-slate-700 px-4 h-14 flex items-center gap-3 shrink-0">
          {/* App title — visible on mobile only (sidebar hidden) */}
          <span className="md:hidden text-base font-bold text-white mr-auto">🚗 EVS</span>
          {/* Desktop spacer to push controls right */}
          <div className="hidden md:block flex-1" />
          <SettingsMenu />
          <ThemeToggle />
          <AccountSwitcher />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900">
          <Outlet />
        </main>

        {/* Bottom nav — mobile only */}
        <nav
          className="md:hidden bg-slate-900 border-t border-slate-700 flex shrink-0"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          {navItems.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn(
                'flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors',
                isActive ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
