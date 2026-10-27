#!/usr/bin/env node
/**
 * monorepo-dashboard — единый дашборд монетизации и аналитики.
 *
 *   • Serves single-page dashboard at /
 *   • /api/aggregated — JSON со статистикой по всем проектам
 *   • /api/analytics — трафик и источники
 *   • /api/leads — email-запросы
 *   • /api/revenue — выручка x402 / staking / LP
 *   • /api/social — посты и вовлечение
 *   • POST /webhook/:project — приём push-статистики
 *   • POST /webhook/lumen-chain/x402
 *   • POST /webhook/perps-funding-pulse/usage
 *   • POST /webhook/agent-x402/payments
 *   • POST /webhook/wallet-hygiene/scans
 *
 * Без внешних зависимостей, только stdlib.
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT || 18900)

// --- in-memory store ---
const store = {
  lumen: {
    blocks: 0, supply: "0", validators: 0, staked: "0",
    x402Payments: 0, x402Revenue: 0, lastX402: null
  },
  perps: {
    fundingRates: [], volume: 0, requests: 0, revenue: 0,
    usage: { totalRequests: 0, totalUsd: 0 }
  },
  agent: {
    requests: 0, revenue: 0,
    x402Payments: 0, x402Revenue: 0
  },
  wallet: {
    scans: 0, keysFound: 0,
    lastScan: null
  },
  analytics: {
    traffic: { daily: 0, weekly: 0, monthly: 0, sources: {} },
    leads: { emails: [], total: 0, daily: 0 },
    revenue: { x402: 0, staking: 0, lp: 0, total: 0, byProject: {} },
    social: { posts: [], engagement: { likes: 0, shares: 0, comments: 0, views: 0 } }
  }
}

function setStats(project, data) {
  if (!(project in store)) return
  store[project] = { ...store[project], ...data, ts: Date.now() }
}

function httpGetJson(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    http.get(url, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        clearTimeout(timer)
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { resolve(null) }
      })
    }).on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

async function pollServices() {
  // lumen-chain explorer
  const lumen = await httpGetJson("http://127.0.0.1:8899/api/state")
  if (lumen && typeof lumen.height === "number") {
    setStats("lumen", {
      blocks: lumen.height,
      supply: lumen.supply || "0",
      validators: lumen.validators || 0,
      staked: lumen.totalStake || "0",
    })
  }

  // perps-funding-pulse
  const perpsUsage = await httpGetJson("http://127.0.0.1:8780/usage")
  if (perpsUsage && perpsUsage.usage) {
    const u = perpsUsage.usage
    setStats("perps", {
      requests: u.totalRequests || 0,
      revenue: u.totalUsd || 0,
      usage: u
    })
  }

  // agent-x402 stats
  const agentStats = await httpGetJson("http://127.0.0.1:8781/stats")
  if (agentStats) {
    setStats("agent", {
      requests: agentStats.requests || 0,
      revenue: agentStats.revenue || 0,
    })
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
  res.end(JSON.stringify(body))
}

function updateAnalyticsFromPayload(payload) {
  if (payload.traffic) {
    store.analytics.traffic = { ...store.analytics.traffic, ...payload.traffic }
  }
  if (payload.lead) {
    const lead = payload.lead
    if (lead.email && !store.analytics.leads.emails.includes(lead.email)) {
      store.analytics.leads.emails.push(lead.email)
      store.analytics.leads.total += 1
      store.analytics.leads.daily += 1
    }
  }
  if (payload.revenue) {
    const r = payload.revenue
    store.analytics.revenue.x402 += Number(r.x402 || 0)
    store.analytics.revenue.staking += Number(r.staking || 0)
    store.analytics.revenue.lp += Number(r.lp || 0)
    store.analytics.revenue.total = store.analytics.revenue.x402 + store.analytics.revenue.staking + store.analytics.revenue.lp
  }
  if (payload.social) {
    if (payload.social.posts) {
      store.analytics.social.posts = [...store.analytics.social.posts, ...payload.social.posts].slice(-200)
    }
    if (payload.social.engagement) {
      const e = store.analytics.social.engagement
      const ne = payload.social.engagement
      e.likes += Number(ne.likes || 0)
      e.shares += Number(ne.shares || 0)
      e.comments += Number(ne.comments || 0)
      e.views += Number(ne.views || 0)
    }
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*")
  res.setHeader("access-control-allow-headers", "content-type")
  if (req.method === "OPTIONS") return res.writeHead(204).end()

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)

  // --- webhook receivers ---
  if (req.method === "POST" && url.pathname === "/webhook/lumen-chain/x402") {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      store.lumen.x402Payments += Number(body.count || 1)
      store.lumen.x402Revenue += Number(body.amount || 0)
      store.lumen.lastX402 = Date.now()
      updateAnalyticsFromPayload(body)
      json(res, 200, { ok: true, project: "lumen-chain", received: body })
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/webhook/perps-funding-pulse/usage") {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      setStats("perps", {
        requests: (store.perps.requests || 0) + Number(body.requests || 0),
        revenue: (store.perps.revenue || 0) + Number(body.revenue || 0),
        usage: { ...store.perps.usage, ...body.usage }
      })
      updateAnalyticsFromPayload(body)
      json(res, 200, { ok: true, project: "perps-funding-pulse", received: body })
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/webhook/agent-x402/payments") {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      store.agent.x402Payments += Number(body.count || 1)
      store.agent.x402Revenue += Number(body.amount || 0)
      updateAnalyticsFromPayload(body)
      json(res, 200, { ok: true, project: "agent-x402", received: body })
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/webhook/wallet-hygiene/scans") {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      store.wallet.scans += Number(body.count || 1)
      store.wallet.keysFound += Number(body.keysFound || 0)
      store.wallet.lastScan = Date.now()
      updateAnalyticsFromPayload(body)
      json(res, 200, { ok: true, project: "wallet-hygiene", received: body })
    })
    return
  }

  // generic webhook fallback
  if (req.method === "POST" && url.pathname.startsWith("/webhook/")) {
    const project = decodeURIComponent(url.pathname.slice("/webhook/".length))
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      setStats(project, body)
      updateAnalyticsFromPayload(body)
      json(res, 200, { ok: true, project, received: body })
    })
    return
  }

  // --- analytics API ---
  if (req.method === "GET" && url.pathname === "/api/analytics") {
    return json(res, 200, {
      ts: Date.now(),
      traffic: store.analytics.traffic,
      sources: Object.entries(store.analytics.traffic.sources || {}).map(([name, value]) => ({ name, value }))
    })
  }

  // --- leads API ---
  if (req.method === "GET" && url.pathname === "/api/leads") {
    return json(res, 200, {
      ts: Date.now(),
      total: store.analytics.leads.total,
      daily: store.analytics.leads.daily,
      emails: store.analytics.leads.emails
    })
  }

  // --- revenue API ---
  if (req.method === "GET" && url.pathname === "/api/revenue") {
    const total = store.analytics.revenue.total + (store.perps.revenue || 0) + (store.agent.revenue || 0) + (store.lumen.x402Revenue || 0)
    return json(res, 200, {
      ts: Date.now(),
      total,
      x402: store.analytics.revenue.x402 + store.lumen.x402Revenue + store.agent.x402Revenue,
      staking: store.analytics.revenue.staking,
      lp: store.analytics.revenue.lp,
      perps: store.perps.revenue || 0,
      byProject: store.analytics.revenue.byProject
    })
  }

  // --- social API ---
  if (req.method === "GET" && url.pathname === "/api/social") {
    return json(res, 200, {
      ts: Date.now(),
      posts: store.analytics.social.posts,
      engagement: store.analytics.social.engagement
    })
  }

  // --- aggregated stats API ---
  if (req.method === "GET" && url.pathname === "/api/aggregated") {
    await pollServices()
    return json(res, 200, {
      ts: Date.now(),
      projects: {
        lumen: store.lumen,
        perps: store.perps,
        agent: store.agent,
        wallet: store.wallet,
      },
      analytics: store.analytics
    })
  }

  // --- serve dashboard ---
  const serveFile = (filePath, contentType) => {
    if (!fs.existsSync(filePath)) return false
    res.writeHead(200, { "content-type": contentType + "; charset=utf-8" })
    res.end(fs.readFileSync(filePath, "utf8"))
    return true
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard.html")) {
    const file = path.join(HERE, "public", "dashboard.html")
    if (serveFile(file, "text/html")) return
    const fallback = path.join(HERE, "index.html")
    if (serveFile(fallback, "text/html")) return
    return res.writeHead(500).end("dashboard not found")
  }

  if (req.method === "GET" && url.pathname === "/index.html") {
    const file = path.join(HERE, "index.html")
    return serveFile(file, "text/html")
  }

  // --- health ---
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { status: "ok", ts: Date.now() })
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: "not_found", hint: "GET /, /api/aggregated, /api/analytics, /api/leads, /api/revenue, /api/social, POST /webhook/..." }))
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[monorepo-dashboard] http://127.0.0.1:${PORT}`)
})
