import https from 'node:https'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'

// iCloud Calendar reader. Talks CalDAV (RFC 4791) directly to
// https://caldav.icloud.com/, parses iCalendar (RFC 5545) responses
// hand-rolled -- the subset we need is small enough that pulling in
// node-ical for it would be overkill.
//
// Auth: app-specific password from appleid.apple.com, stored on disk
// at ~/.config/icloud-caldav/credentials.json (0600). NEVER log it.
// Discovery (principal -> calendar-home) is cached in discovery.json
// so we don't burn two extra PROPFIND round-trips per call.

const CREDS_DIR = join(homedir(), '.config', 'icloud-caldav')
const CREDS_PATH = join(CREDS_DIR, 'credentials.json')
const DISCOVERY_PATH = join(CREDS_DIR, 'discovery.json')
const PRINCIPAL_URL = 'https://caldav.icloud.com/'
const REQUEST_TIMEOUT_MS = 20_000

interface Credentials {
  username: string
  password: string
}

interface CalendarInfo {
  href: string         // absolute path under calendar-home, e.g. "/10661899684/calendars/home/"
  name: string         // displayname from DAV:
  homeUrl: string      // full https URL of calendar-home
  host: string         // host portion for https requests
}

export interface CalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  status?: string
  location?: string
  description?: string
  attendees?: Array<{ email: string; responseStatus?: string; displayName?: string }>
}

interface DiscoveryCache {
  calendarHomeHref: string  // absolute href like "/10661899684/calendars/"
  calendarHomeUrl: string   // full URL like "https://p56-caldav.icloud.com:443/10661899684/calendars/"
  cachedAt: number
}

let cachedCreds: Credentials | null = null

function loadCredentials(): Credentials {
  if (cachedCreds) return cachedCreds
  if (!existsSync(CREDS_PATH)) {
    throw new Error(`iCloud CalDAV credentials missing at ${CREDS_PATH}`)
  }
  const parsed = JSON.parse(readFileSync(CREDS_PATH, 'utf-8')) as Credentials
  if (!parsed.username || !parsed.password) {
    throw new Error('iCloud CalDAV credentials file malformed (need username + password)')
  }
  cachedCreds = parsed
  return parsed
}

function loadDiscovery(): DiscoveryCache | null {
  if (!existsSync(DISCOVERY_PATH)) return null
  try {
    return JSON.parse(readFileSync(DISCOVERY_PATH, 'utf-8')) as DiscoveryCache
  } catch {
    return null
  }
}

function saveDiscovery(d: DiscoveryCache): void {
  if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(DISCOVERY_PATH, JSON.stringify(d, null, 2), { mode: 0o600 })
}

// RFC 6764 / Apple: discover the calendar-home-set for the principal.
// Two-step: principal -> calendar-home-set. Cache the result.
async function discoverCalendarHome(): Promise<DiscoveryCache> {
  const cached = loadDiscovery()
  if (cached && Date.now() - cached.cachedAt < 7 * 24 * 60 * 60 * 1000) return cached

  const creds = loadCredentials()

  // Step 1: principal URL from the server root
  const step1Body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<d:propfind xmlns:d="DAV:">` +
    `<d:prop><d:current-user-principal/></d:prop>` +
    `</d:propfind>`
  const step1Xml = await davRequest('PROPFIND', PRINCIPAL_URL, creds, '0', step1Body)
  const principalHref = extractHrefByTag(step1Xml, 'current-user-principal')
  if (!principalHref) throw new Error('iCloud CalDAV: principal discovery failed')

  // Step 2: calendar-home-set on the principal
  const principalUrl = new URL(principalHref, PRINCIPAL_URL).toString()
  const step2Body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><c:calendar-home-set/></d:prop>` +
    `</d:propfind>`
  const step2Xml = await davRequest('PROPFIND', principalUrl, creds, '0', step2Body)
  const homeHref = extractHrefByTag(step2Xml, 'calendar-home-set')
  if (!homeHref) throw new Error('iCloud CalDAV: calendar-home-set discovery failed')

  const homeUrl = new URL(homeHref, principalUrl).toString()
  const discovery: DiscoveryCache = {
    calendarHomeHref: new URL(homeUrl).pathname,
    calendarHomeUrl: homeUrl,
    cachedAt: Date.now(),
  }
  saveDiscovery(discovery)
  return discovery
}

// DAV request. body is XML for PROPFIND/REPORT, undefined for GET. Returns
// response body as a string. Status 207 Multi-Status is the normal DAV success.
function davRequest(
  method: 'PROPFIND' | 'REPORT',
  url: string,
  creds: Credentials,
  depth: '0' | '1',
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL
    try { parsedUrl = new URL(url) } catch { return reject(new Error(`Invalid URL: ${url}`)) }
    const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')

    const req = https.request({
      method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Depth': depth,
        'Content-Type': 'application/xml; charset=utf-8',
        'Accept': 'application/xml, text/xml',
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text)
        } else {
          // Do NOT include the response body -- it can echo calendar data
          // and we don't want a 401 page leaking into logs. The status +
          // our own context is enough to debug.
          reject(new Error(`iCloud CalDAV ${method} ${parsedUrl.pathname} -> HTTP ${res.statusCode}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('iCloud CalDAV request timed out')) })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// Pulls the first <href> inside a <TAG> property from a multistatus body.
function extractHrefByTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*<href[^>]*>([^<]+)</href>\\s*</${tag}>`, 's')
  const m = re.exec(xml)
  return m ? m[1].trim() : null
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const discovery = await discoverCalendarHome()
  const creds = loadCredentials()
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<d:propfind xmlns:d="DAV:">` +
    `<d:prop><d:resourcetype/><d:displayname/></d:prop>` +
    `</d:propfind>`
  const xml = await davRequest('PROPFIND', discovery.calendarHomeUrl, creds, '1', body)

  // Extract every (href, displayname) pair from the multistatus response.
  const results: CalendarInfo[] = []
  const responseRe = /<response[^>]*>([\s\S]*?)<\/response>/g
  let m: RegExpExecArray | null
  while ((m = responseRe.exec(xml))) {
    const block = m[1]
    const hrefMatch = /<href[^>]*>([^<]+)<\/href>/.exec(block)
    if (!hrefMatch) continue
    const href = hrefMatch[1].trim()
    if (!href.endsWith('/')) continue  // only calendar collections
    if (/\/(inbox|outbox|notification)\/?$/.test(href)) continue  // system collections
    // Skip non-calendar collections (those without calendar resourcetype)
    if (!/<resourcetype[^>]*>[^]*<calendar\s+xmlns="urn:ietf:params:xml:ns:caldav"\s*\/>/.test(block)) continue

    const nameMatch = /<displayname[^>]*>([^<]*)<\/displayname>/.exec(block)
    const name = nameMatch ? decodeXml(nameMatch[1]).trim() : href.split('/').filter(Boolean).pop() || href

    const homeUrl = new URL(discovery.calendarHomeUrl)
    const absUrl = new URL(href, homeUrl).toString()
    const homeHost = homeUrl.host

    results.push({ href, name, homeUrl: absUrl, host: homeHost })
  }
  return results
}

// Resolve a user-supplied identifier (calendar name like "Személyes", or a
// href like "/10661899684/calendars/home/") to a CalendarInfo.
async function resolveCalendar(calendarIdOrName: string | undefined): Promise<CalendarInfo> {
  const cals = await listCalendars()
  if (cals.length === 0) throw new Error('iCloud CalDAV: no calendars discovered')
  if (!calendarIdOrName || calendarIdOrName.trim() === '') {
    // Default: prefer "home" calendar (Apple's default Personal calendar)
    const home = cals.find(c => c.href.endsWith('/calendars/home/'))
    return home || cals[0]
  }
  const needle = calendarIdOrName.trim().toLowerCase()
  const exact = cals.find(c => c.name.toLowerCase() === needle || c.href === calendarIdOrName)
  if (exact) return exact
  const partial = cals.find(c => c.name.toLowerCase().includes(needle))
  if (partial) return partial
  throw new Error(`iCloud CalDAV: calendar not found for "${calendarIdOrName}". Available: ${cals.map(c => c.name).join(', ')}`)
}

// CalDAV REPORT calendar-query: returns all VEVENTs in [start, end).
// Times are passed as UTC (with trailing Z). Apple accepts UTC; floating
// times (without TZID) would require per-event VTIMEZONE lookup which we
// skip -- all iCloud events observed so far are stored as Z.
export async function getEvents(
  calendarIdOrName: string | undefined,
  start: Date,
  end: Date,
): Promise<CalendarEvent[]> {
  const cal = await resolveCalendar(calendarIdOrName)
  const creds = loadCredentials()
  const startISO = start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')  // YYYYMMDDTHHMMSSZ
  const endISO = end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter>` +
    `<c:comp-filter name="VCALENDAR">` +
    `<c:comp-filter name="VEVENT">` +
    `<c:time-range start="${startISO}" end="${endISO}"/>` +
    `</c:comp-filter>` +
    `</c:comp-filter>` +
    `</c:filter>` +
    `</c:calendar-query>`

  const xml = await davRequest('REPORT', cal.homeUrl, creds, '1', body)
  const events: CalendarEvent[] = []
  const dataRe = /<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/g
  let m: RegExpExecArray | null
  while ((m = dataRe.exec(xml))) {
    const ical = decodeXml(m[1])
    const ev = parseFirstVEvent(ical)
    if (ev) events.push(ev)
  }
  return events
}

// --- iCalendar parsing (RFC 5545, VEVENT subset) ---

// Unfold lines: per RFC 5545 section 3.1, a line that begins with a single
// whitespace character is a continuation of the previous line. Apple
// returns folded lines for long SUMMARY/DESCRIPTION.
function unfoldIcal(text: string): string {
  return text.replace(/\r?\n[ \t]/g, '')
}

// Decode XML entities (&amp;, &lt;, &gt;, &quot;, &apos;, &#NN;).
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')  // last, to avoid double-decoding
}

// iCalendar text escaping (RFC 5545 section 3.3.11).
function unescapeIcal(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function parseFirstVEvent(ical: string): CalendarEvent | null {
  const unfolded = unfoldIcal(ical)
  // Apple sometimes wraps responses in CDATA -- strip a leading <![CDATA[
  // that may have leaked through XML decoding (multistatus puts calendar-data
  // as text, but rfc 4791 allows either inline or by-reference; we get inline).
  const start = unfolded.indexOf('BEGIN:VEVENT')
  if (start < 0) return null
  const end = unfolded.indexOf('END:VEVENT', start)
  if (end < 0) return null
  const block = unfolded.slice(start, end + 'END:VEVENT'.length)

  const props: Record<string, { value: string; params: Record<string, string> }> = {}
  // Properties we expect to repeat: EXDATE, ATTENDEE. For everything else,
  // first-write-wins.
  const attendees: Array<{ email: string; responseStatus?: string; displayName?: string }> = []

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('BEGIN:') || rawLine.startsWith('END:')) continue
    const colonIdx = rawLine.indexOf(':')
    if (colonIdx < 0) continue
    const namePart = rawLine.slice(0, colonIdx)
    const value = rawLine.slice(colonIdx + 1)

    const semiParts = namePart.split(';')
    const name = semiParts[0].toUpperCase()
    const params: Record<string, string> = {}
    for (let i = 1; i < semiParts.length; i++) {
      const eq = semiParts[i].indexOf('=')
      if (eq < 0) continue
      params[semiParts[i].slice(0, eq).toUpperCase()] = semiParts[i].slice(eq + 1)
    }

    if (name === 'ATTENDEE') {
      const mailto = value.replace(/^mailto:/i, '')
      const status = params['PARTSTAT']
      const cn = params['CN']
      attendees.push({
        email: mailto,
        responseStatus: status,
        displayName: cn ? unescapeIcal(decodeXml(cn)) : undefined,
      })
      continue
    }

    if (!(name in props)) {
      props[name] = { value, params }
    }
  }

  const uid = props['UID']?.value
  if (!uid) return null

  const ev: CalendarEvent = { id: uid }
  if (props['SUMMARY']) ev.summary = unescapeIcal(decodeXml(props['SUMMARY'].value))
  if (props['STATUS']) ev.status = props['STATUS'].value
  if (props['LOCATION']) ev.location = unescapeIcal(decodeXml(props['LOCATION'].value))
  if (props['DESCRIPTION']) ev.description = unescapeIcal(decodeXml(props['DESCRIPTION'].value))
  if (attendees.length > 0) ev.attendees = attendees

  const dtstart = props['DTSTART']
  const dtend = props['DTEND']
  if (dtstart) ev.start = parseIcalDateTime(dtstart.value, dtstart.params['VALUE'])
  if (dtend) ev.end = parseIcalDateTime(dtend.value, dtend.params['VALUE'])

  return ev
}

// iCalendar date forms: YYYYMMDD (date-only, 8 chars), YYYYMMDDTHHMMSS
// (floating, 15 chars), YYYYMMDDTHHMMSSZ (UTC, 16 chars). We emit ISO 8601
// strings compatible with the Google Calendar CalendarEvent shape.
function parseIcalDateTime(value: string, forceValue?: string): { dateTime?: string; date?: string } {
  const cleaned = value.trim()
  if (cleaned.length === 8 || forceValue === 'DATE') {
    return { date: `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}` }
  }
  if (cleaned.length === 16 && cleaned.endsWith('Z')) {
    // UTC datetime: YYYYMMDDTHHMMSSZ -> YYYY-MM-DDTHH:MM:SS.000Z
    const y = cleaned.slice(0, 4)
    const mo = cleaned.slice(4, 6)
    const d = cleaned.slice(6, 8)
    const h = cleaned.slice(9, 11)
    const mi = cleaned.slice(11, 13)
    const s = cleaned.slice(13, 15)
    return { dateTime: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z` }
  }
  if (cleaned.length === 15) {
    // Floating time (no TZ, no Z): emit as local-time ISO without offset.
    // iCloud rarely produces these for events with DTSTART.
    const y = cleaned.slice(0, 4)
    const mo = cleaned.slice(4, 6)
    const d = cleaned.slice(6, 8)
    const h = cleaned.slice(9, 11)
    const mi = cleaned.slice(11, 13)
    const s = cleaned.slice(13, 15)
    return { dateTime: `${y}-${mo}-${d}T${h}:${mi}:${s}` }
  }
  // Unrecognized -- pass through verbatim, heartbeat will log a warning.
  return { dateTime: cleaned }
}