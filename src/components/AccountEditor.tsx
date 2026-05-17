import { useState } from 'react'
import type { Account } from '@/store/config'
import { evsClient } from '@/api/evs'
import { cn } from '@/lib/utils'

interface Props {
  initial?: Account
  onSave: (a: Account) => void
  onCancel?: () => void
}

export default function AccountEditor({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleSave = async () => {
    if (!name.trim() || !email.trim() || !password) return
    setStatus('testing')
    setErrorMsg('')
    try {
      evsClient.loadAccountTokens(name.trim())
      evsClient.clearTokens()
      const { studentId } = await evsClient.signIn(email.trim(), password)
      setStatus('ok')
      onSave({ name: name.trim(), email: email.trim(), password, studentId, anonymous: false })
    } catch (err) {
      setErrorMsg((err as Error).message)
      setStatus('error')
    }
  }

  const canSave = name.trim() && email.trim() && password && status !== 'testing'

  return (
    <form onSubmit={e => { e.preventDefault(); handleSave() }} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Account name</label>
        <input
          className="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="e.g. My account"
          value={name}
          onChange={e => { setName(e.target.value); setStatus('idle') }}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Email</label>
        <input
          type="email"
          className="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="you@example.com"
          value={email}
          onChange={e => { setEmail(e.target.value); setStatus('idle') }}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Password</label>
        <input
          type="password"
          className="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="••••••••"
          value={password}
          onChange={e => { setPassword(e.target.value); setStatus('idle') }}
        />
      </div>

      {status === 'ok' && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">✓ Sign-in successful</p>
      )}
      {status === 'error' && (
        <p className="text-sm text-red-600 dark:text-red-400">✗ {errorMsg}</p>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!canSave}
          className={cn(
            'flex-1 rounded-lg py-2 text-sm font-semibold text-white transition-colors',
            canSave ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed',
          )}
        >
          {status === 'testing' ? 'Signing in…' : 'Save & sign in'}
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
