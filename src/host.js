'use strict'
// The server the app runs on: CPU, memory and disk, sampled every 30 seconds.
// Inside a container (Docker, Kubernetes) the container's own limits count,
// not the whole machine's (cgroup v2). Never throws.

const fs = require('node:fs')
const os = require('node:os')

const CGROUP = '/sys/fs/cgroup'

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function meminfo() {
  const out = {}
  for (const line of (read('/proc/meminfo') || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) out[m[1]] = Number(m[2]) / 1024 // kB -> MB
  }
  return out
}

function cgroupCpuLimit() {
  const raw = (read(`${CGROUP}/cpu.max`) || '').trim().split(/\s+/)
  if (raw.length === 2 && raw[0] !== 'max') {
    const v = Number(raw[0]) / Number(raw[1])
    return Number.isFinite(v) && v > 0 ? v : null
  }
  return null
}

function cgroupCpuUsec() {
  const m = /^usage_usec (\d+)/m.exec(read(`${CGROUP}/cpu.stat`) || '')
  return m ? Number(m[1]) : null
}

function cgroupMemory() {
  const limit = (read(`${CGROUP}/memory.max`) || '').trim()
  const current = (read(`${CGROUP}/memory.current`) || '').trim()
  if (!limit || limit === 'max' || !/^\d+$/.test(current)) return null
  let used = Number(current)
  const m = /^inactive_file (\d+)/m.exec(read(`${CGROUP}/memory.stat`) || '')
  if (m) used -= Number(m[1]) // page cache the kernel can drop: not really in use
  return [Math.max(used, 0) / 1048576, Number(limit) / 1048576]
}

function machineCpu() {
  let busy = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    const all = t.user + t.nice + t.sys + t.idle + t.irq
    total += all
    busy += all - t.idle
  }
  return [busy, total]
}

const r1 = (v) => Math.round(v * 10) / 10

class HostSampler {
  constructor(root) {
    this.root = root && fs.existsSync(root) ? root : '/'
    this.prev = null
    this.sample() // the first reading only primes the CPU counters
  }

  cpu() {
    const limit = cgroupCpuLimit()
    const now = Number(process.hrtime.bigint()) / 1e9
    if (limit) {
      const usec = cgroupCpuUsec()
      if (usec === null) return [null, limit]
      const prev = this.prev
      this.prev = [now, usec, 0]
      if (!prev || now <= prev[0]) return [null, limit]
      return [Math.min(100, ((usec - prev[1]) / 1e6 / (now - prev[0]) / limit) * 100), limit]
    }
    const cpus = os.cpus().length || 1
    const [busy, total] = machineCpu()
    const prev = this.prev
    this.prev = [now, busy, total]
    if (!prev || total <= prev[2]) return [null, cpus]
    return [((busy - prev[1]) / (total - prev[2])) * 100, cpus]
  }

  sample() {
    const r = { ts: Math.round(Date.now()) / 1000 }
    try {
      const [cpu, cpus] = this.cpu()
      if (cpu !== null) r.cpu_pct = r1(Math.max(cpu, 0))
      if (cpus) r.cpus = Math.round(cpus * 100) / 100
    } catch {}
    try {
      if (process.platform !== 'win32') r.load1 = Math.round(os.loadavg()[0] * 100) / 100
    } catch {}
    try {
      const cg = cgroupMemory()
      if (cg) {
        r.mem_used_pct = r1((cg[0] / cg[1]) * 100)
        r.mem_total_mb = Math.round(cg[1])
      } else {
        const mi = process.platform === 'linux' ? meminfo() : {}
        if (mi.MemTotal && mi.MemAvailable !== undefined) {
          r.mem_used_pct = r1((1 - mi.MemAvailable / mi.MemTotal) * 100)
          r.mem_total_mb = Math.round(mi.MemTotal)
          if (mi.SwapTotal) r.swap_used_pct = r1((1 - (mi.SwapFree || 0) / mi.SwapTotal) * 100)
        } else {
          r.mem_used_pct = r1((1 - os.freemem() / os.totalmem()) * 100)
          r.mem_total_mb = Math.round(os.totalmem() / 1048576)
        }
      }
    } catch {}
    try {
      if (fs.statfsSync) {
        const s = fs.statfsSync(this.root)
        if (s.blocks) r.disk_used_pct = r1(((s.blocks - s.bfree) / s.blocks) * 100)
      }
    } catch {}
    try {
      r.process_mem_mb = r1(process.memoryUsage.rss() / 1048576)
    } catch {}
    return r
  }
}

module.exports = { HostSampler }
