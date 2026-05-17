import { X } from 'lucide-react'
import TimeEditor from './TimeEditor'
import type { TimeProfile } from '@/store/config'
import { useEscapeKey } from '@/hooks/useKeyShortcuts'

interface Props {
  initial?: TimeProfile
  onSave: (t: TimeProfile) => void
  onClose: () => void
}

export default function TimeModal({ initial, onSave, onClose }: Props) {
  useEscapeKey(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{initial ? 'Edit time profile' : 'Add time profile'}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <TimeEditor initial={initial} onSave={onSave} onCancel={onClose} />
      </div>
    </div>
  )
}
