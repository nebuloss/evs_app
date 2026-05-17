import { cn } from '@/lib/utils'

export interface ProgressState {
  phase: 'evict' | 'structure' | 'slots' | 'done' | 'idle'
  message: string
  current: number
  total: number
}

interface Props {
  state: ProgressState
}

const phaseOrder = ['evict', 'structure', 'slots', 'done']

function phasePercent(state: ProgressState): number {
  if (state.phase === 'idle') return 0
  if (state.phase === 'done') return 100
  if (state.phase === 'slots' && state.total > 0) {
    const base = 40
    return base + Math.round((state.current / state.total) * 55)
  }
  if (state.phase === 'structure') return 20
  if (state.phase === 'evict') return 5
  return 0
}

export default function FetchProgress({ state }: Props) {
  if (state.phase === 'idle') return null

  const pct = phasePercent(state)
  const isDone = state.phase === 'done'
  const isError = state.message.startsWith('Error:')

  return (
    <div className="space-y-3">
      {/* Progress bar */}
      <div className="relative h-3 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-indigo-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Phase steps */}
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {phaseOrder.map((ph, i) => {
          const idx = phaseOrder.indexOf(state.phase)
          const done = i < idx || isDone
          const active = ph === state.phase && !isDone
          return (
            <span
              key={ph}
              className={cn(
                'capitalize',
                done && 'text-emerald-600 dark:text-emerald-400 font-medium',
                active && 'text-indigo-600 dark:text-indigo-400 font-semibold',
              )}
            >
              {ph}
              {i < phaseOrder.length - 1 && <span className="ml-2 text-slate-300 dark:text-slate-600">→</span>}
            </span>
          )
        })}
      </div>

      {/* Message */}
      <p
        className={cn(
          'text-sm',
          isError ? 'text-red-600 dark:text-red-400' : isDone ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-slate-600 dark:text-slate-300',
        )}
      >
        {state.message}
        {state.phase === 'slots' && state.total > 0 && (
          <span className="ml-1 text-slate-400 dark:text-slate-500">
            ({state.current}/{state.total})
          </span>
        )}
      </p>
    </div>
  )
}
