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

import type { Slot } from '@/core/snapshot'

// ── Errors ──────────────────────────────────────────────────────────────────────

/** Thrown on a non-2xx EVS response. Carries the HTTP status so callers can
 *  distinguish an expected 404 (e.g. a teacher with no slots) from a real
 *  backend/auth failure (401/5xx) that should be surfaced to the user. */
export class EvsHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'EvsHttpError'
  }
}

/**
 * True when an error means the user's session has expired and could not be
 * renewed automatically (stored password rejected, or token revoked with no
 * way to recover). Callers use this to prompt the user to sign in again
 * instead of showing a raw failure.
 */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof EvsHttpError && err.status === 401
}

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

/**
 * Best-effort extraction of a human-readable reason from an EVS error response.
 * The backend is inconsistent about error shape — depending on the endpoint a
 * failure comes back as `{ errors: ["msg"] }`, `{ errors: { base: ["msg"] } }`
 * (Rails validation style), `{ errors: [{ detail }] }` (JSON:API), `{ error }`,
 * `{ message }`, or `{ full_messages }`. We try them all, and if none match we
 * still surface the HTTP status + a snippet of the body so the reason is never
 * fully swallowed (which is what left bookings showing only "Booking failed").
 */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  let text = ''
  try { text = await res.text() } catch { /* body unreadable */ }
  let body: unknown = null
  if (text) { try { body = JSON.parse(text) } catch { /* not JSON */ } }

  const fromValue = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim() || null
    if (Array.isArray(v)) {
      const parts = v.map(x =>
        typeof x === 'string' ? x
          : x && typeof x === 'object'
            ? String((x as Record<string, unknown>).detail ?? (x as Record<string, unknown>).message ?? (x as Record<string, unknown>).title ?? '')
            : '',
      ).filter(Boolean)
      return parts.length ? parts.join(' · ') : null
    }
    if (v && typeof v === 'object') {
      // Rails-style { field: ["msg", …] } — flatten the messages across fields.
      const parts = Object.values(v as Record<string, unknown>).flatMap(x =>
        Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string')
          : typeof x === 'string' ? [x] : [])
      return parts.length ? parts.join(' · ') : null
    }
    return null
  }

  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const msg = fromValue(b.errors) ?? fromValue(b.error) ?? fromValue(b.message) ?? fromValue(b.full_messages)
    if (msg) return msg
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  return snippet ? `${fallback} (HTTP ${res.status}: ${snippet})` : `${fallback} (HTTP ${res.status})`
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

// ── EVSClient ─────────────────────────────────────────────────────────────────

export class EVSClient {
  private tokens: AuthTokens | null = null
  private accountName: string | null = null
  // Credentials of the active account, remembered so the client can transparently
  // re-authenticate when the backend rejects a stored token with 401.
  private creds: { email: string; password: string } | null = null
  // Shared in-flight re-auth, so a burst of concurrent 401s triggers a single sign-in.
  private reauth: Promise<void> | null = null

  /**
   * Switches the active account by loading its tokens from localStorage.
   * Must be called before any API request when the active account may have changed.
   */
  loadAccountTokens(accountName: string): void {
    this.accountName = accountName
    this.tokens = loadTokensFor(accountName)
  }

  /** Remembers the active account's credentials for transparent 401 recovery. */
  setCredentials(email: string, password: string): void {
    this.creds = { email, password }
  }

  /** Signs in once for a burst of concurrent 401s (deduped via a shared promise). */
  private ensureReauth(): Promise<void> {
    if (!this.creds) return Promise.reject(new Error('No credentials for re-auth'))
    if (!this.reauth) {
      const { email, password } = this.creds
      this.reauth = this.signIn(email, password).then(() => undefined).finally(() => { this.reauth = null })
    }
    return this.reauth
  }

  private async request(method: string, path: string, body?: unknown, isRetry = false): Promise<Response> {
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

    // Self-heal: a 401 means our stored token was rejected even though it wasn't
    // locally expired (rotated/invalidated/corrupted). Re-sign-in once and retry —
    // this is what makes a search recover instead of silently returning nothing.
    const isAuthCall = path === '/api/auth' || path === '/api/auth/sign_in'
    if (res.status === 401 && !isRetry && !isAuthCall && this.creds) {
      try {
        await this.ensureReauth()
        return await this.request(method, path, body, true)
      } catch {
        return res  // re-auth failed — surface the original 401 to the caller
      }
    }

    return res
  }

  /** Returns true if there are no tokens, or they expire within the next 60 seconds. */
  isExpired(): boolean {
    if (!this.tokens) return true
    return this.tokens.expiry < Date.now() / 1000 + 60
  }

  /**
   * Prepares the client for authenticated requests. ALWAYS remembers the
   * credentials (even when the stored token still looks valid) so the request
   * layer can transparently re-sign-in on a server-side 401 — a token can be
   * rotated/revoked by the backend while its local `expiry` still reads valid
   * (e.g. after it was refreshed on another device/tab). Only performs an eager
   * sign-in when the token is locally expired, deduped across concurrent callers.
   */
  async ensureAuth(email: string, password: string): Promise<void> {
    this.setCredentials(email, password)
    if (this.isExpired()) await this.ensureReauth()
  }

  async signIn(email: string, password: string): Promise<{ tokens: AuthTokens; studentId: string }> {
    this.setCredentials(email, password)
    const res = await this.request('POST', '/api/auth/sign_in', { email, password })
    if (!res.ok) {
      throw new EvsHttpError(res.status, await readErrorMessage(res, 'Sign-in failed'))
    }
    const data = await res.json() as { data: { id: string } }
    if (!this.tokens) throw new Error('No tokens returned from sign-in')
    return { tokens: this.tokens, studentId: String(data.data.id) }
  }

  async getStudentProfile(studentId: string): Promise<StudentProfile> {
    const res = await this.request('GET', `/api/v1/students/${studentId}`)
    if (!res.ok) throw new EvsHttpError(res.status, 'Failed to get account info')
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
    if (!res.ok) throw new EvsHttpError(res.status, 'Failed to get lessons')
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
    if (!res.ok) throw new EvsHttpError(res.status, 'Failed to get credits history')
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
      throw new EvsHttpError(res.status, await readErrorMessage(res, 'Booking failed'))
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

/**
 * Module-level singleton shared across the entire app.
 *
 * This is intentional: the EVS API is stateful (token rotation on every
 * response), and React Query's caching already prevents duplicate requests.
 * Before any request, callers must call `loadAccountTokens(name)` to ensure
 * the singleton holds the correct account's tokens.
 */
export const evsClient = new EVSClient()
