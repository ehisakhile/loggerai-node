'use strict'
// Masks secrets before anything leaves the app: by key name (fields, headers,
// query parameters) and by shape (bearer tokens and JWTs anywhere in a string).
// The same rules as LoggerAI's server, browser script and other SDKs.

const MASK = '[REDACTED]'

// A key is sensitive when one of its words is one of these
// ("accessToken" -> access, token; "X-CSRF-Token" -> x, csrf, token).
const WORDS = new Set([
  'password', 'passwd', 'pwd', 'pass', 'passphrase', 'secret', 'token', 'otp', 'pin', 'cvv', 'cvc',
  'ssn', 'cookie', 'authorization', 'auth', 'signature', 'sig', 'credential', 'credentials', 'bvn', 'nin',
  // where someone is: user_lat, userLng, pickup_latitude... (analytics never keep locations)
  'lat', 'lng', 'lon', 'latitude', 'longitude', 'coords', 'coordinates', 'geolocation', 'gps',
])
// ...or when its words run together into one of these ("x-api-key" -> xapikey).
const JOINED = [
  'apikey', 'accesskey', 'privatekey', 'secretkey', 'cardnumber', 'clientsecret', 'sessionid',
  'authtoken', 'accesstoken', 'refreshtoken', 'idtoken', 'csrftoken', 'xsrf', 'setcookie',
  'latlng', 'latlon', 'lnglat', 'lonlat', 'geopoint',
]
// Query parameters that carry credentials in URLs (e.g. Google's ?key=).
const URL_EXTRA = new Set(['key', 'code', 'access_token', 'id_token', 'll', 'location']) // ?ll=6.52,3.37 (maps)

const SPLIT = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const BEARER = /\b(bearer|basic|token)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi
// A latitude,longitude pair anywhere, e.g. in a path: /nearby/6.524379,3.379206
const COORDS = /(?<![\d.])-?\d{1,3}\.\d{4,}\s*(?:,|%2C)\s*-?\d{1,3}\.\d{4,}(?![\d.])/gi
const URLISH = /^https?:\/\//i

function isSensitive(key) {
  if (typeof key !== 'string' || !key) return false
  const words = key.split(SPLIT).filter(Boolean).map((w) => w.toLowerCase())
  if (words.some((w) => WORDS.has(w))) return true
  const joined = words.join('')
  return JOINED.some((j) => joined.includes(j))
}

function redactString(s) {
  if (typeof s !== 'string') return s
  return s.replace(JWT, '[REDACTED_JWT]').replace(COORDS, '[REDACTED_LOCATION]').replace(BEARER, (_m, kind) => `${kind} ${MASK}`)
}

function redactUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return redactString(url)
  }
  if (u.username || u.password) {
    u.username = MASK
    u.password = ''
  }
  for (const [k, v] of [...u.searchParams]) {
    if (v && (isSensitive(k) || URL_EXTRA.has(k.toLowerCase()))) u.searchParams.set(k, MASK)
  }
  return redactString(u.toString())
}

function redactText(s) {
  const t = s.trim()
  if (t[0] === '{' || t[0] === '[') {
    try {
      return JSON.stringify(redact(JSON.parse(t)))
    } catch {}
  }
  if (URLISH.test(t)) return redactUrl(t)
  if (t.includes('=') && !t.includes(' ') && t.length < 20000) {
    const params = new URLSearchParams(t)
    const pairs = [...params]
    if (pairs.length && pairs.some(([k]) => isSensitive(k))) {
      return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${isSensitive(k) && v ? MASK : encodeURIComponent(v)}`).join('&')
    }
  }
  return redactString(s)
}

/** A copy of value with secrets masked. Safe on any JSON-like data. */
function redact(value, depth = 0) {
  if (depth > 40) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && v && !Object.keys(v).length)
      if (isSensitive(k) && !empty) out[k] = MASK
      else if (['url', 'href', 'referrer', 'referer', 'location'].includes(k.toLowerCase()) && typeof v === 'string') out[k] = redactUrl(v)
      else out[k] = redact(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') return value ? redactText(value) : value
  return value
}

module.exports = { MASK, isSensitive, redact, redactString, redactUrl }
