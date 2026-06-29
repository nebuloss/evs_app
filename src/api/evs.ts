/**
 * EVS API client — typed wrapper around the En Voiture Simone mobile API.
 *
 * All requests go through the local Express proxy (/proxy/*) which injects the
 * Origin / Referer / User-Agent headers required by the EVS backend.  Direct
 * browser requests are rejected by EVS's CORS policy, hence the proxy layer.
 *
 * Auth model: EVS uses the devise-token-auth scheme (access-token / client /
 * uid / expiry headers).  Fresh tokens are returned with every response and
 * must be stored and re-sent on the next request.  Tokens expire after ~2
 * weeks (checked via the `expiry` unix-seconds field).
 *
 * Per-account storage: each account keeps its own token set in localStorage
 * under the key `evs_tokens_<accountName>`.  Call `loadAccountTokens(name)`
 * before any request to load the right account's tokens into the client.
 */

import type { Gearbox } from '@/core/search'
import type { PairMeta, Slot } from '@/core/snapshot'
import { haversineKm, type Point } from '@/core/geo'

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthTokens {
  authorization: string
  accessToken: string
  client: string
  uid: string
  /** Unix timestamp (seconds) after which the token is invalid. */
  expiry: number
  tokenType: string
}

// ── API response types ────────────────────────────────────────────────────────

export interface MeetingPoint {
  id: string
  name: string
  lat: number
  lng: number
  /** ISO datetime of the next free slot, or null if the point has no upcoming
   *  availability. Null points are skipped before fetching teachers/slots. */
  nextAvailability: string | null
}

export interface Teacher {
  id: string
  firstName: string
  automaticCar: boolean
  rating: number
  nbRating: number
}

export interface StudentProfile {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  credits: number
  cdrStatus: string
}

export interface LessonTeacher {
  firstName: string
  lastName: string
  phone: string
  carBrand: string
  carModel: string
}

export interface LessonPoint {
  name: string
  city: string
  lat: number
  lng: number
}

export interface Lesson {
  id: string
  status: string
  startsAt: string
  endsAt: string
  credits: number
  durationMinutes: number
  automatic: boolean
  teacher: LessonTeacher
  departurePoint: LessonPoint | null
  cancelledAt: string | null
  confirmedAt: string | null
}

export interface CreditExpiry {
  creditType: string
  total: number
  expiresAt: string
  amount: number
}

export interface CreditProvision {
  name: string
  price: string
  discountPrice: string | null
  providedAt: string
  remainingCredits: number
  expiries: CreditExpiry[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Version string sent in X-App-Version — must match a version the EVS backend accepts.
const APP_VERSION = '1.155.5'
const BASE = '/proxy'

// ── Token storage helpers ─────────────────────────────────────────────────────

function tokenKey(accountName: string): string {
  return `evs_tokens_${accountName}`
}

function saveTokens(accountName: string, t: AuthTokens): void {
  localStorage.setItem(tokenKey(accountName), JSON.stringify(t))
}

function loadTokensFor(accountName: string): AuthTokens | null {
  const raw = localStorage.getItem(tokenKey(accountName))
  if (!raw) return null
  try { return JSON.parse(raw) as AuthTokens } catch { return null }
}

/** Extracts the devise-token-auth headers from a response, returning null if any are missing. */
function extractTokens(headers: Headers): AuthTokens | null {
  const authorization = headers.get('authorization')
  const accessToken = headers.get('access-token')
  const client = headers.get('client')
  const uid = headers.get('uid')
  const expiry = headers.get('expiry')
  const tokenType = headers.get('token-type') ?? 'Bearer'
  if (!authorization || !accessToken || !client || !uid || !expiry) return null
  return { authorization, accessToken, client, uid, expiry: parseInt(expiry, 10), tokenType }
}

// ── Random helpers for anonymous registration ─────────────────────────────────

function randStr(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz'
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function randPhone(): string {
  const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('')
  return `06${digits}`
}

// ── EVSClient ─────────────────────────────────────────────────────────────────

export class EVSClient {
  private tokens: AuthTokens | null = null
  private accountName: string | null = null

  /**
   * Switches the active account by loading its tokens from localStorage.
   * Must be called before any API request when the active account may have changed.
   */
  loadAccountTokens(accountName: string): void {
    this.accountName = accountName
    this.tokens = loadTokensFor(accountName)
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-App-Version': APP_VERSION,
      'evs_auth_issued_at': Date.now().toString(),
    }

    if (this.tokens) {
      headers['Authorization'] = this.tokens.authorization
      headers['Access-Token'] = this.tokens.accessToken
      headers['Client'] = this.tokens.client
      headers['Uid'] = this.tokens.uid
      headers['Token-Type'] = this.tokens.tokenType
    }

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })

    // Persist refreshed tokens from the response so the next request stays authenticated.
    const newTokens = extractTokens(res.headers)
    if (newTokens) {
      this.tokens = newTokens
      if (this.accountName) saveTokens(this.accountName, newTokens)
    }

    return res
  }

  /** Returns true if there are no tokens, or they expire within the next 60 seconds. */
  isExpired(): boolean {
    if (!this.tokens) return true
    return this.tokens.expiry < Date.now() / 1000 + 60
  }

  /** Signs in only if the current tokens are expired; otherwise does nothing. */
  async ensureAuth(email: string, password: string): Promise<string | null> {
    if (!this.isExpired()) return null
    return (await this.signIn(email, password)).studentId
  }

  async signIn(email: string, password: string): Promise<{ tokens: AuthTokens; studentId: string }> {
    const res = await this.request('POST', '/api/auth/sign_in', { email, password })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { errors?: string[] }).errors?.[0] ?? 'Sign-in failed')
    }
    const data = await res.json() as { data: { id: string } }
    if (!this.tokens) throw new Error('No tokens returned from sign-in')
    return { tokens: this.tokens, studentId: String(data.data.id) }
  }

  async registerAnonymous(): Promise<{ tokens: AuthTokens; studentId: string; email: string; password: string }> {
    const email = `${randStr(10)}.${randStr(6)}@evs-anon.local`
    const password = randStr(16)
    const res = await this.request('POST', '/api/auth', {
      email,
      password,
      passwordConfirmation: password,
      additionalData: {
        first_name: randStr(6),
        last_name: randStr(6),
        postal_code_id: 6187,
        birthday: '1990-01-01',
        phone: randPhone(),
        nl_subscribed: false,
        user_signup_type: 'spa',
      },
      confirm_success_url: 'https://app.envoituresimone.com/login/register',
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { errors?: string[] }).errors?.[0] ?? 'Registration failed')
    }
    const data = await res.json() as { data: { id: string } }
    if (!this.tokens) throw new Error('No tokens returned from registration')
    return { tokens: this.tokens, studentId: String(data.data.id), email, password }
  }

  async getMeetingPoints(lat: number, lng: number, gearbox: Gearbox): Promise<MeetingPoint[]> {
    const qs = new URLSearchParams({ latitude: lat.toString(), longitude: lng.toString(), gearbox_type: gearbox })
    const res = await this.request('GET', `/api/v3/availabilities?${qs}`)
    if (!res.ok) throw new Error('Failed to get meeting points')
    const data = await res.json() as { data: Array<{ id: string; name: string; latitude: number; longitude: number; next_availability: string | null }> }
    return data.data.map(p => ({ id: p.id, name: p.name, lat: p.latitude, lng: p.longitude, nextAvailability: p.next_availability ?? null }))
  }

  /**
   * Discovers ALL meeting points within `radiusKm` of `center`.
   *
   * Why this is non-trivial: the `/availabilities` endpoint ignores any radius
   * parameter and only ever returns the ~20 NEAREST points to the queried
   * coordinate (in dense areas like central Paris those 20 are all within ~4km).
   * A single query therefore can't cover a 20km radius — searching Paris vs
   * Clamart (9km apart) returns two completely disjoint sets of 20 points.
   *
   * Fix: tile the area with an adaptive quadtree. The crucial property is that
   * "20 nearest" means a result of 20 points whose farthest is at distance D
   * guarantees we have EVERY point within D of the query. So each query covers a
   * disc of radius D; we subdivide a cell only when it hit the 20-cap AND the
   * cell still extends beyond that coverage. Cells are queried in parallel,
   * level by level (results dedup by point id). Adapts to density: sparse areas
   * stop after one query, dense areas subdivide until covered.
   */
  async discoverMeetingPoints(
    center: Point,
    radiusKm: number,
    gearbox: Gearbox,
    onProgress?: (found: number, queries: number) => void,
    shouldStop?: () => boolean,
  ): Promise<{ points: MeetingPoint[]; queries: number; truncated: boolean }> {
    const CAP = 20            // backend hard cap on points per query
    const CONCURRENCY = 16    // measured sweet spot; endpoint throttles past this
    const MAX_QUERIES = 500   // safety bound on a single discovery
    const MIN_CELL_KM = 0.4   // stop subdividing below this to avoid runaway recursion

    interface Cell { minLat: number; maxLat: number; minLng: number; maxLng: number }
    const kmPerDegLat = 111
    const kmPerDegLng = 111 * Math.cos((center.lat * Math.PI) / 180)
    const dLat = radiusKm / kmPerDegLat
    const dLng = radiusKm / kmPerDegLng

    const corners = (c: Cell): Point[] => [
      { lat: c.minLat, lng: c.minLng }, { lat: c.minLat, lng: c.maxLng },
      { lat: c.maxLat, lng: c.minLng }, { lat: c.maxLat, lng: c.maxLng },
    ]
    const cellCenter = (c: Cell): Point => ({ lat: (c.minLat + c.maxLat) / 2, lng: (c.minLng + c.maxLng) / 2 })
    // A cell is relevant only if it intersects the search disc.
    const intersectsDisc = (c: Cell): boolean =>
      haversineKm(center, cellCenter(c)) <= radiusKm ||
      corners(c).some(k => haversineKm(center, k) <= radiusKm)

    // Discs we've already fully resolved: every point within `cov` of `q` is known.
    // A cell whose every corner lies inside one of these discs is redundant — skip it.
    const covered: Array<{ q: Point; cov: number }> = []
    const isCovered = (c: Cell): boolean =>
      covered.some(d => corners(c).every(k => haversineKm(d.q, k) <= d.cov))

    const found = new Map<string, MeetingPoint>()
    let queries = 0
    let active = 0
    let truncated = false
    const queue: Cell[] = [{ minLat: center.lat - dLat, maxLat: center.lat + dLat, minLng: center.lng - dLng, maxLng: center.lng + dLng }]

    // Continuous work-pool: keep CONCURRENCY queries in flight at all times,
    // subdividing on the fly — no per-level barrier idle (much faster than BFS).
    await new Promise<void>(resolve => {
      const pump = (): void => {
        // Nothing more can be launched once the queue drains OR we hit the query cap.
        // Resolve when that's true and all in-flight requests have drained — also on
        // cancel. (Without the cap check this deadlocks: at MAX_QUERIES with cells still
        // queued, no new request is launched so finally→pump never fires again.)
        const exhausted = queue.length === 0 || queries >= MAX_QUERIES
        if ((exhausted || shouldStop?.()) && active === 0) return resolve()
        if (shouldStop?.()) return  // cancelled: stop launching; in-flight drains via finally→pump
        while (active < CONCURRENCY && queue.length > 0 && queries < MAX_QUERIES) {
          const cell = queue.shift()!
          if (!intersectsDisc(cell) || isCovered(cell)) continue
          active++; queries++
          const q = cellCenter(cell)
          this.getMeetingPoints(q.lat, q.lng, gearbox).then(pts => {
            for (const p of pts) found.set(p.id, p)
            if (pts.length > 0) covered.push({ q, cov: Math.max(...pts.map(p => haversineKm(q, p))) })
            if (pts.length >= CAP) {
              const coverage = Math.max(...pts.map(p => haversineKm(q, p)))
              const halfDiag = Math.max(...corners(cell).map(k => haversineKm(q, k)))
              if (halfDiag > coverage && halfDiag > MIN_CELL_KM) {
                const mLat = (cell.minLat + cell.maxLat) / 2
                const mLng = (cell.minLng + cell.maxLng) / 2
                queue.push(
                  { minLat: cell.minLat, maxLat: mLat, minLng: cell.minLng, maxLng: mLng },
                  { minLat: cell.minLat, maxLat: mLat, minLng: mLng, maxLng: cell.maxLng },
                  { minLat: mLat, maxLat: cell.maxLat, minLng: cell.minLng, maxLng: mLng },
                  { minLat: mLat, maxLat: cell.maxLat, minLng: mLng, maxLng: cell.maxLng },
                )
              }
            }
            onProgress?.(found.size, queries)
          }).catch(() => {}).finally(() => { active--; pump() })
        }
        if (queries >= MAX_QUERIES && queue.length > 0) truncated = true
      }
      pump()
    })

    return { points: [...found.values()], queries, truncated }
  }

  async getLocationTeachers(locationId: string, gearbox: Gearbox): Promise<Teacher[]> {
    const qs = new URLSearchParams({ gearbox_type: gearbox })
    const res = await this.request('GET', `/api/v3/locations/${locationId}/teachers?${qs}`)
    if (!res.ok) throw new Error(`Failed to get teachers for location ${locationId}`)
    const data = await res.json() as {
      data: {
        teachers: Array<{
          id: string
          first_name: string
          automatic_car: boolean
          rating: number
          nb_rating: number
        }>
      }
    }
    return data.data.teachers.map(t => ({
      id: t.id,
      firstName: t.first_name,
      automaticCar: t.automatic_car,
      rating: t.rating,
      nbRating: t.nb_rating,
    }))
  }

  async getTeacherAvailabilities(
    locationId: string,
    teacherId: string,
    gearbox: Gearbox,
    pair: PairMeta,
  ): Promise<Slot[]> {
    const qs = new URLSearchParams({ teacher_id: teacherId, gearbox_type: gearbox })
    const res = await this.request('GET', `/api/v3/locations/${locationId}/teachers_availabilities?${qs}`)
    if (!res.ok) throw new Error(`Failed to get availabilities for teacher ${teacherId}`)
    const data = await res.json() as {
      data: Array<{ date: string; slots: Array<{ starts_at: string; duration: number }> }>
    }

    const slots: Slot[] = []
    for (const day of data.data) {
      for (const s of day.slots) {
        const utcDate = new Date(s.starts_at)
        // 'sv-SE' produces "YYYY-MM-DD HH:MM:SS" in the given timezone — cheapest way
        // to get a local datetime string without a date library.
        const localStr = utcDate.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).replace(' ', 'T')
        slots.push({
          locationId,
          locationName: pair.locationName,
          locationLat: pair.locationLat,
          locationLng: pair.locationLng,
          teacherId,
          teacherName: pair.teacherName,
          teacherRating: pair.teacherRating,
          teacherAutomaticCar: pair.teacherAutomaticCar,
          gearboxType: gearbox,
          startsAtLocal: localStr,
          startsAtUtc: s.starts_at,
          durationMinutes: Math.round(s.duration / 60),
          bookingUrl: buildBookingUrl(locationId, teacherId, s.starts_at, gearbox),
        })
      }
    }
    return slots
  }

  async getStudentProfile(studentId: string): Promise<StudentProfile> {
    const res = await this.request('GET', `/api/v1/students/${studentId}`)
    if (!res.ok) throw new Error('Failed to get student profile')
    const data = await res.json() as {
      data: { id: string; attributes: { first_name: string; last_name: string; email: string; phone: string; credits: number; cdr_status: string } }
    }
    const a = data.data.attributes
    return {
      id: data.data.id,
      firstName: a.first_name,
      lastName: a.last_name,
      email: a.email,
      phone: a.phone,
      credits: a.credits,
      cdrStatus: a.cdr_status,
    }
  }

  async getLessons(studentId: string, state?: string): Promise<Lesson[]> {
    const qs = state ? `?state=${encodeURIComponent(state)}` : ''
    const res = await this.request('GET', `/api/v1/account/${studentId}/lessons${qs}`)
    if (!res.ok) throw new Error('Failed to get lessons')
    const data = await res.json() as {
      data: Array<{
        id: string
        attributes: {
          status: string
          starts_at: string
          ends_at: string
          credits: number
          duration: number
          automatic: boolean
          cancelled_at: string | null
          confirmed_at: string | null
          teacher: { first_name: string; last_name: string; phone: string; car_brand: string; car_model: string }
          departure_point: { name: string; city: string; latitude: number; longitude: number } | null
        }
      }>
    }
    return data.data.map(d => {
      const a = d.attributes
      return {
        id: d.id,
        status: a.status,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
        credits: a.credits,
        durationMinutes: Math.round(a.duration / 60),
        automatic: a.automatic,
        cancelledAt: a.cancelled_at,
        confirmedAt: a.confirmed_at,
        teacher: {
          firstName: a.teacher.first_name,
          lastName: a.teacher.last_name,
          phone: a.teacher.phone,
          carBrand: a.teacher.car_brand,
          carModel: a.teacher.car_model,
        },
        departurePoint: a.departure_point ? {
          name: a.departure_point.name,
          city: a.departure_point.city,
          lat: a.departure_point.latitude,
          lng: a.departure_point.longitude,
        } : null,
      }
    })
  }

  async getCreditsHistory(studentId: string): Promise<CreditProvision[]> {
    const res = await this.request('GET', `/api/v1/account/${studentId}/credits_provisions_history`)
    if (!res.ok) throw new Error('Failed to get credits history')
    const data = await res.json() as {
      data: Array<{
        name: string
        price: string
        discount_price: string | null
        provided_at: string
        remaining_credits: number
        expiries: Array<{ credit_type: string; total: number; expires_at: string; amount: number }> | null
      }>
    }
    return data.data.map(d => ({
      name: d.name,
      price: d.price,
      discountPrice: d.discount_price,
      providedAt: d.provided_at,
      remainingCredits: d.remaining_credits,
      expiries: (d.expiries ?? []).map(e => ({
        creditType: e.credit_type,
        total: e.total,
        expiresAt: e.expires_at,
        amount: e.amount,
      })),
    }))
  }

  async bookLesson(slot: Slot): Promise<string | null> {
    const startsAt = new Date(slot.startsAtUtc)
    const endsAt = new Date(startsAt.getTime() + slot.durationMinutes * 60_000)
    const res = await this.request('POST', '/api/v3/lessons', {
      teacher_id: slot.teacherId,
      departure_id: slot.locationId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      automatic: slot.gearboxType === 'bva',
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { errors?: string[] }).errors?.[0] ?? 'Booking failed')
    }
    const data = await res.json() as { data?: { id?: string } }
    return data.data?.id ?? null
  }

  getTokens(): AuthTokens | null { return this.tokens }

  clearTokens(): void {
    this.tokens = null
    if (this.accountName) localStorage.removeItem(tokenKey(this.accountName))
  }
}

function buildBookingUrl(locationId: string, teacherId: string, startsAt: string, gearbox: Gearbox): string {
  const params = new URLSearchParams({ location_id: locationId, teacher_id: teacherId, starts_at: startsAt, gearbox_type: gearbox })
  return `https://app.envoituresimone.com/booking?${params}`
}

/**
 * Module-level singleton shared across the entire app.
 *
 * This is intentional: the EVS API is stateful (token rotation on every
 * response), and React Query's caching already prevents duplicate requests.
 * Before any request, callers must call `loadAccountTokens(name)` to ensure
 * the singleton holds the correct account's tokens.
 */
export const evsClient = new EVSClient()
