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

/**
 * Parses the calendar parts of a timezone-less local datetime string,
 * e.g. "2024-06-08T23:30:00" → { y, mo, d, hh, mm }.
 *
 * We deliberately do NOT use `new Date(startsAtLocal)` here: that relies on the
 * engine parsing a timezone-less string as *local* time, which iOS Safari does
 * inconsistently (some versions assume UTC). That shifts late-evening slots
 * across midnight and flips their weekday — so e.g. Saturday slots get matched
 * as Sunday, making a "Sat + Sun" filter silently drop all Saturday slots on
 * mobile. Parsing the fixed-format string directly is engine-independent.
 */
function localParts(s: string): { y: number; mo: number; d: number; hh: number; mm: number } {
  return {
    y: Number(s.slice(0, 4)),
    mo: Number(s.slice(5, 7)),
    d: Number(s.slice(8, 10)),
    hh: Number(s.slice(11, 13)),
    mm: Number(s.slice(14, 16)),
  }
}

/** ISO weekday (1=Mon…7=Sun) for a Y-M-D date, computed in UTC to avoid local-tz drift. */
function isoWeekday(y: number, mo: number, d: number): number {
  const jsDay = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0=Sun…6=Sat
  return jsDay === 0 ? 7 : jsDay
}

/** Returns true if the slot's start time satisfies the given time specification. */
export function matchesTime(spec: TimeSpec, slot: SlotTime): boolean {
  if (spec.type === 'precise') {
    const slotMs = new Date(slot.startsAtLocal).getTime()
    const targetMs = new Date(spec.at).getTime()
    return Math.abs(slotMs - targetMs) <= spec.toleranceMinutes * 60_000
  }

  const { y, mo, d, hh, mm } = localParts(slot.startsAtLocal)
  const dow = isoWeekday(y, mo, d)
  if (spec.weekdays.length > 0 && !spec.weekdays.includes(dow)) return false

  if (spec.windows.length === 0) return true
  const slotMin = hh * 60 + mm
  return spec.windows.some(w => slotMin >= toMinutes(w.start) && slotMin < toMinutes(w.end))
}
