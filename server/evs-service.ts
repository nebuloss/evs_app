/**
 * Server-side EVS client used to populate the shared slot cache.
 *
 * Availability data (meeting points, teachers, slots) is identical for every
 * user, so the server reads it with a single auto-managed ANONYMOUS session:
 * it registers a throwaway account on first use, persists creds+tokens to disk,
 * refreshes on expiry, self-heals on 401, and re-registers if the account dies.
 * No real credentials are ever involved — booking still uses each user's own
 * token on the client.
 *
 * All EVS calls go through a global concurrency throttle so the (heavily
 * rate-limited) EVS backend is never hammered, no matter how many clients search
 * at once.
 */

import https from 'https'
import fs from 'fs'
import path from 'path'
import type { Slot, PairMeta, Gearbox } from '../src/core/types'

const EVS_BASE = 'https://api.envoituresimone.com'
const APP_VERSION = '1.155.5'
const MAX_CONCURRENCY = Number(process.env.EVS_MAX_CONCURRENCY ?? 16)

const CACHE_DIR = process.env.EVS_CACHE_DIR || path.join(process.cwd(), 'cache')
const ANON_FILE = path.join(CACHE_DIR, 'anon.json')

const INJECTED_HEADERS: Record<string, string> = {
  Origin: 'https://app.envoituresimone.com',
  Referer: 'https://app.envoituresimone.com/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
}

// Local Paris datetime as "YYYY-MM-DDTHH:MM:SS", computed locale-independently.
// We read the numeric parts rather than relying on a locale string, because
// small-ICU Node builds (common on appliances) lack the 'sv-SE' locale and would
// fall back to a US format → "Invalid Date" in the client. en-US + Europe/Paris
// are always available (tz data ships with ICU).
const PARIS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function parisLocalIso(d: Date): string {
  const p: Record<string, string> = {}
  for (const part of PARIS_FMT.formatToParts(d)) p[part.type] = part.value
  const hour = p.hour === '24' ? '00' : p.hour  // some ICU emit '24' for midnight
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`
}

// ── Errors ──────────────────────────────────────────────────────────────────────

export class EvsHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'EvsHttpError'
  }
}

// ── Geo (inlined to keep the server self-contained) ──────────────────────────────

export interface Point { lat: number; lng: number }

export function haversineKm(a: Point, b: Point): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const sLat = Math.sin(dLat / 2)
  const sLng = Math.sin(dLng / 2)
  const h = sLat * sLat + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sLng * sLng
  return R * 2 * Math.asin(Math.sqrt(h))
}

// ── Global throttle (shared across all clients) ──────────────────────────────────

let active = 0
const waiters: Array<() => void> = []
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) { active++; return }
  await new Promise<void>(resolve => waiters.push(resolve))
  active++
}
function release(): void {
  active--
  const next = waiters.shift()
  if (next) next()
}

// ── Low-level HTTPS JSON request ─────────────────────────────────────────────────

interface RawResponse { status: number; headers: Record<string, string | undefined>; body: string }

function rawRequest(method: string, url: string, headers: Record<string, string>, body?: string): Promise<RawResponse> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string | undefined>, body: data }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ── Auth tokens (anonymous service session) ──────────────────────────────────────

interface Tokens { authorization: string; accessToken: string; client: string; uid: string; expiry: number; tokenType: string }
interface AnonState { email: string; password: string; tokens: Tokens | null }

function extractTokens(h: Record<string, string | undefined>): Tokens | null {
  const authorization = h['authorization']
  const accessToken = h['access-token']
  const client = h['client']
  const uid = h['uid']
  const expiry = h['expiry']
  const tokenType = h['token-type'] ?? 'Bearer'
  if (!authorization || !accessToken || !client || !uid || !expiry) return null
  return { authorization, accessToken, client, uid, expiry: parseInt(expiry, 10), tokenType }
}

function randStr(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}
function randPhone(): string {
  let d = ''
  for (let i = 0; i < 8; i++) d += Math.floor(Math.random() * 10)
  return `06${d}`
}

class AnonSession {
  private state: AnonState | null = null
  private reauth: Promise<void> | null = null

  private load(): void {
    if (this.state) return
    try {
      this.state = JSON.parse(fs.readFileSync(ANON_FILE, 'utf8')) as AnonState
    } catch { this.state = null }
  }

  private persist(): void {
    if (!this.state) return
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(ANON_FILE, JSON.stringify(this.state))
    } catch (err) { console.warn('Failed to persist anon session:', (err as Error).message) }
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-App-Version': APP_VERSION,
      'evs_auth_issued_at': Date.now().toString(),
    }
    const t = this.state?.tokens
    if (t) {
      h['Authorization'] = t.authorization
      h['Access-Token'] = t.accessToken
      h['Client'] = t.client
      h['Uid'] = t.uid
      h['Token-Type'] = t.tokenType
    }
    return { ...INJECTED_HEADERS, ...h }
  }

  private isExpired(): boolean {
    const t = this.state?.tokens
    if (!t) return true
    return t.expiry < Date.now() / 1000 + 60
  }

  private async register(): Promise<void> {
    const email = `${randStr(10)}.${randStr(6)}@evs-anon.local`
    const password = randStr(16)
    const res = await rawRequest('POST', `${EVS_BASE}/api/auth`, { ...INJECTED_HEADERS, 'Content-Type': 'application/json', 'X-App-Version': APP_VERSION }, JSON.stringify({
      email, password, passwordConfirmation: password,
      additionalData: { first_name: randStr(6), last_name: randStr(6), postal_code_id: 6187, birthday: '1990-01-01', phone: randPhone(), nl_subscribed: false, user_signup_type: 'spa' },
      confirm_success_url: 'https://app.envoituresimone.com/login/register',
    }))
    if (res.status < 200 || res.status >= 300) throw new EvsHttpError(res.status, 'Anonymous registration failed')
    this.state = { email, password, tokens: extractTokens(res.headers) }
    this.persist()
    // Registration tokens aren't accepted on data endpoints — sign in to get usable tokens.
    await this.signIn()
  }

  private async signIn(): Promise<void> {
    if (!this.state) throw new Error('No anon credentials to sign in')
    const res = await rawRequest('POST', `${EVS_BASE}/api/auth/sign_in`, { ...INJECTED_HEADERS, 'Content-Type': 'application/json', 'X-App-Version': APP_VERSION }, JSON.stringify({ email: this.state.email, password: this.state.password }))
    if (res.status < 200 || res.status >= 300) throw new EvsHttpError(res.status, 'Anonymous sign-in failed')
    this.state.tokens = extractTokens(res.headers)
    this.persist()
  }

  /** Ensures we hold a usable token, registering or signing in as needed. */
  async ensure(): Promise<void> {
    this.load()
    if (!this.state) { await this.register(); return }
    if (this.isExpired()) {
      try { await this.signIn() }
      catch { await this.register() }  // creds rejected → start fresh
    }
  }

  private ensureReauth(): Promise<void> {
    if (!this.reauth) {
      this.reauth = (async () => {
        try { await this.signIn() }
        catch { await this.register() }
      })().finally(() => { this.reauth = null })
    }
    return this.reauth
  }

  /** Authenticated GET against EVS with one transparent 401 recovery. */
  async get(pathStr: string, isRetry = false): Promise<RawResponse> {
    await acquire()
    let res: RawResponse
    try {
      res = await rawRequest('GET', `${EVS_BASE}${pathStr}`, this.authHeaders())
    } finally { release() }
    const fresh = extractTokens(res.headers)
    if (fresh && this.state) { this.state.tokens = fresh; this.persist() }
    if (res.status === 401 && !isRetry) {
      await this.ensureReauth()
      return this.get(pathStr, true)
    }
    return res
  }
}

const session = new AnonSession()

// ── EVS read API ─────────────────────────────────────────────────────────────────

export interface MeetingPoint { id: string; name: string; lat: number; lng: number; nextAvailability: string | null }

function buildBookingUrl(locationId: string, teacherId: string, startsAt: string, gearbox: Gearbox): string {
  const params = new URLSearchParams({ location_id: locationId, teacher_id: teacherId, starts_at: startsAt, gearbox_type: gearbox })
  return `https://app.envoituresimone.com/booking?${params}`
}

export async function ensureAuth(): Promise<void> { await session.ensure() }

export async function getMeetingPoints(lat: number, lng: number, gearbox: Gearbox): Promise<MeetingPoint[]> {
  const qs = new URLSearchParams({ latitude: lat.toString(), longitude: lng.toString(), gearbox_type: gearbox })
  const res = await session.get(`/api/v3/availabilities?${qs}`)
  if (res.status < 200 || res.status >= 300) throw new EvsHttpError(res.status, 'Failed to get meeting points')
  const data = JSON.parse(res.body) as { data: Array<{ id: string; name: string; latitude: number; longitude: number; next_availability: string | null }> }
  return (data.data ?? []).map(p => ({ id: p.id, name: p.name, lat: p.latitude, lng: p.longitude, nextAvailability: p.next_availability ?? null }))
}

export interface Teacher { id: string; firstName: string; automaticCar: boolean; rating: number; nbRating: number }

export async function getLocationTeachers(locationId: string, gearbox: Gearbox): Promise<Teacher[]> {
  const qs = new URLSearchParams({ gearbox_type: gearbox })
  const res = await session.get(`/api/v3/locations/${locationId}/teachers?${qs}`)
  if (res.status < 200 || res.status >= 300) throw new EvsHttpError(res.status, `Failed to get teachers for location ${locationId}`)
  const data = JSON.parse(res.body) as { data?: { teachers?: Array<{ id: string; first_name: string | null; automatic_car: boolean; rating: number | null; nb_rating: number | null }> } }
  const teachers = data?.data?.teachers
  if (!Array.isArray(teachers)) return []
  const num = (x: unknown): number => (typeof x === 'number' && isFinite(x) ? x : 0)
  // Teachers with no ratings yet come back with null rating — coerce so slots never
  // carry null (which would crash the client and be dropped by the cache sanitizer).
  return teachers.map(t => ({ id: t.id, firstName: t.first_name ?? '', automaticCar: !!t.automatic_car, rating: num(t.rating), nbRating: num(t.nb_rating) }))
}

export async function getTeacherAvailabilities(locationId: string, teacherId: string, gearbox: Gearbox, pair: PairMeta): Promise<Slot[]> {
  const qs = new URLSearchParams({ teacher_id: teacherId, gearbox_type: gearbox })
  const res = await session.get(`/api/v3/locations/${locationId}/teachers_availabilities?${qs}`)
  if (res.status < 200 || res.status >= 300) throw new EvsHttpError(res.status, `Failed to get availabilities for teacher ${teacherId}`)
  const data = JSON.parse(res.body) as { data?: Array<{ date: string; slots: Array<{ starts_at: string; duration: number }> }> }
  const days = Array.isArray(data?.data) ? data.data : []
  const slots: Slot[] = []
  for (const day of days) {
    for (const s of day.slots ?? []) {
      const localStr = parisLocalIso(new Date(s.starts_at))
      slots.push({
        locationId, locationName: pair.locationName, locationLat: pair.locationLat, locationLng: pair.locationLng,
        teacherId, teacherName: pair.teacherName, teacherRating: pair.teacherRating, teacherAutomaticCar: pair.teacherAutomaticCar,
        gearboxType: gearbox, startsAtLocal: localStr, startsAtUtc: s.starts_at,
        durationMinutes: Math.round(s.duration / 60), bookingUrl: buildBookingUrl(locationId, teacherId, s.starts_at, gearbox),
      })
    }
  }
  return slots
}

// ── Adaptive quadtree discovery (ported from the client) ─────────────────────────

export interface DiscoverResult { points: MeetingPoint[]; queries: number; truncated: boolean; failures: number }

export async function discoverMeetingPoints(
  center: Point,
  radiusKm: number,
  gearbox: Gearbox,
  onProgress?: (found: number, queries: number) => void,
  shouldStop?: () => boolean,
): Promise<DiscoverResult> {
  const CAP = 20
  const CONCURRENCY = MAX_CONCURRENCY
  const MAX_QUERIES = 500
  const MIN_CELL_KM = 0.4

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
  const intersectsDisc = (c: Cell): boolean =>
    haversineKm(center, cellCenter(c)) <= radiusKm || corners(c).some(k => haversineKm(center, k) <= radiusKm)

  const covered: Array<{ q: Point; cov: number }> = []
  const isCovered = (c: Cell): boolean => covered.some(d => corners(c).every(k => haversineKm(d.q, k) <= d.cov))

  const found = new Map<string, MeetingPoint>()
  let queries = 0
  let inFlight = 0
  let truncated = false
  let failures = 0
  const queue: Cell[] = [{ minLat: center.lat - dLat, maxLat: center.lat + dLat, minLng: center.lng - dLng, maxLng: center.lng + dLng }]

  await new Promise<void>(resolve => {
    const pump = (): void => {
      const exhausted = queue.length === 0 || queries >= MAX_QUERIES
      if ((exhausted || shouldStop?.()) && inFlight === 0) return resolve()
      if (shouldStop?.()) return
      while (inFlight < CONCURRENCY && queue.length > 0 && queries < MAX_QUERIES) {
        const cell = queue.shift()!
        if (!intersectsDisc(cell) || isCovered(cell)) continue
        inFlight++; queries++
        const q = cellCenter(cell)
        getMeetingPoints(q.lat, q.lng, gearbox).then(pts => {
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
        }).catch(() => { failures++ }).finally(() => { inFlight--; pump() })
      }
      if (queries >= MAX_QUERIES && queue.length > 0) truncated = true
    }
    pump()
  })

  return { points: [...found.values()], queries, truncated, failures }
}
