/**
 * Time-filter matching logic.
 *
 * Two filter modes are supported:
 *   - `schedule`: filter by weekday(s) and/or time window(s).
 *   - `precise`: check whether a slot starts within N minutes of a target time.
 *
 * Only the `schedule` mode is currently exposed in the UI; `precise` is available
 * for programmatic use (e.g. polling for a specific slot).
 */

export interface TimeWindow {
  start: string  // "HH:MM"
  end: string    // "HH:MM"
}

export interface ScheduleTime {
  type: 'schedule'
  /** ISO weekdays: 1=Mon … 7=Sun. Empty array means any weekday. */
  weekdays: number[]
  /** Time ranges during the day. Empty array means any time. */
  windows: TimeWindow[]
}

export interface PreciseTime {
  type: 'precise'
  /** Target ISO datetime. */
  at: string
  toleranceMinutes: number
}

export type TimeSpec = ScheduleTime | PreciseTime

export interface SlotTime {
  /** ISO local datetime string (no timezone suffix), e.g. "2024-06-01T09:00:00". */
  startsAtLocal: string
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Returns true if the slot's start time satisfies the given time specification. */
export function matchesTime(spec: TimeSpec, slot: SlotTime): boolean {
  if (spec.type === 'precise') {
    const slotMs = new Date(slot.startsAtLocal).getTime()
    const targetMs = new Date(spec.at).getTime()
    return Math.abs(slotMs - targetMs) <= spec.toleranceMinutes * 60_000
  }

  const d = new Date(slot.startsAtLocal)
  // JS getDay() returns 0=Sun…6=Sat; convert to ISO 1=Mon…7=Sun.
  const dow = d.getDay() === 0 ? 7 : d.getDay()
  if (spec.weekdays.length > 0 && !spec.weekdays.includes(dow)) return false

  if (spec.windows.length === 0) return true
  const slotMin = d.getHours() * 60 + d.getMinutes()
  return spec.windows.some(w => slotMin >= toMinutes(w.start) && slotMin < toMinutes(w.end))
}
