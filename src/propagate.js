'use strict'
// Which outgoing calls carry the trace on. No Node-only modules here: the edge build uses it too.

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/
const INTERNAL_SUFFIX = /\.(local|internal|svc|cluster\.local|lan|home\.arpa|consul|localdomain)$/i

/** Hosts that are the project's own services by default: names without a dot (Docker and
 * Kubernetes service names), private addresses, and internal DNS suffixes. Others only when
 * configured, so outside APIs (Stripe, OpenAI) never get your trace ids or service names. */
function isInternalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h === '::1' || PRIVATE_V4.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false
  return !h.includes('.') || INTERNAL_SUFFIX.test(h)
}

/** propagate: true (everywhere), false (nowhere), or a list of hosts and patterns
 * ("api.example.com", "*.example.com"); internal hosts are always included unless false. */
function propagationRule(option, envValue) {
  let v = option
  if (v === undefined && envValue !== undefined && envValue !== '') {
    const s = String(envValue).trim().toLowerCase()
    v = s === 'all' || s === 'true' ? true : s === 'none' || s === 'false' ? false : String(envValue).split(',')
  }
  if (v === true || v === false) return () => v
  const patterns = (Array.isArray(v) ? v : []).map((p) => String(p).trim().toLowerCase()).filter(Boolean)
  return (host) => {
    const h = String(host || '').toLowerCase()
    if (isInternalHost(h)) return true
    return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p))
  }
}

module.exports = { isInternalHost, propagationRule }
