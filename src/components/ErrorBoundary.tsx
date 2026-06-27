import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * App-wide safety net. Without this, any uncaught render-phase throw (e.g. a
 * localStorage write failing inside a state updater on iOS Safari) unmounts the
 * whole React tree, leaving a blank white screen with unresponsive controls.
 * Here we catch it and render a recoverable fallback instead.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled error caught by ErrorBoundary:', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 px-6">
          <div className="max-w-sm w-full text-center space-y-4">
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">Something went wrong</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              The app hit an unexpected error. Reloading usually fixes it.
            </p>
            <p className="text-xs text-red-600 dark:text-red-400 font-mono break-words">
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-5 py-2.5"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
