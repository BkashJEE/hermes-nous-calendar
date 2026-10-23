// hermes-nous-calendar: desktop half. Plain ESM, loaded uncompiled by Hermes Desktop (no JSX, no build).
//
// Surfaces: route /nous-calendar (sidebar row "Nous Calendar" + ⌘K "Open Nous Calendar") and a
// status-bar chip that counts drops since you last opened the page.
// Data: the plugin's own backend first, ctx.rest('/month?month=…&tz=…') -> dashboard/plugin_api.py.
//       If it isn't mounted, the CLI through the local gateway: `hermes nous-calendar --json --compact`.
//       An optional "On X" layer comes from a LOCAL curated file when one is configured (never fetched).
// Alerts: one desktop notification per NEW release or official plugin (never on the first visit).
// Look: the Hermes Daily Drops sheet: paper, ink, Hermes blue, Anton dates, hairline grid.
//       Fonts ship in ./fonts (OFL); system fallbacks keep it readable if they can't load.

import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-nous-calendar'
const ROUTE = '/nous-calendar'
const REFRESH_MS = 30 * 60000
const CLI_TIMEOUT_MS = 240000
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } })()
const SHINE_VIEWS = 150000

// What a day is called, strongest first. GitHub kinds and the X feed's types share one ladder.
const LABELS = [
  { key: 'release', word: 'Release', cls: 't-release' },
  { key: 'launch', word: 'Launch', cls: 't-launch' },
  { key: 'official', word: 'Official plugin', cls: 't-launch' },
  { key: 'model', word: 'Free model', cls: 't-model' },
  { key: 'news', word: 'News', cls: 't-news' },
  { key: 'feature', word: 'Feature', cls: 't-feature' },
  { key: 'plugin-update', word: 'Plugin update', cls: 't-update' },
  { key: 'catalog', word: 'Catalog', cls: 't-catalog' },
  { key: 'build', word: 'Build', cls: 't-build' },
]
const MAJOR = new Set(['release', 'official'])
const COUNTED = new Set(['release', 'official', 'feature'])   // what the "new drops" chip counts
const FILTERS = [
  ['all', 'All days'], ['release', 'Releases'], ['launch', 'Launches'], ['official', 'Official plugins'],
  ['feature', 'Features'], ['catalog', 'Catalog'],
]

// h('div', {className}, child, child…): jsx/jsxs without JSX.
const h = (type, props, ...children) => (children.length > 1 ? jsxs : jsx)(type, { ...(props || {}), children: children.length === 1 ? children[0] : children })

// ── fonts ───────────────────────────────────────────────────────────────────
function fontFaces() {
  let base = ''
  try { base = new URL('./fonts/', import.meta.url).href } catch { return '' }
  const face = (fam, file, weight) => `@font-face{font-family:"${fam}";src:url("${base}${file}") format("woff2");font-weight:${weight};font-display:swap}`
  return face('NC Anton', 'Anton.woff2', '400') + face('NC Instrument Sans', 'InstrumentSans.woff2', '400 700') + face('NC JetBrains Mono', 'JetBrainsMono.woff2', '400 800')
}

// ── data ────────────────────────────────────────────────────────────────────
let pluginCtx = null
let backend = null              // 'rest' | 'cli', once one has answered
let os = null

async function resolveRoute() {
  const routes = await host.profileRoutes()
  const route = routes.find((r) => r.mode === 'local' && r.primary) || routes.find((r) => r.mode === 'local') || routes.find((r) => r.primary) || routes[0]
  if (!route) throw new Error('No Hermes profile route available')
  return route
}
function parseCliJson(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try { return JSON.parse(lines[i]) } catch { /* keep looking */ }
  }
  throw new Error(lines.slice(-2).join(' ') || 'empty output from hermes nous-calendar')
}
const withDeadline = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out reading GitHub')), ms))])

async function viaCli(month, refresh) {
  const route = await resolveRoute()
  const argv = ['--profile', route.targetProfile, 'nous-calendar', '--json', '--compact', '--month', month, ...(TZ ? ['--tz', TZ] : []), ...(refresh ? ['--refresh'] : [])]
  const res = await withDeadline(host.requestProfile(route, 'cli.exec', { argv, timeout: CLI_TIMEOUT_MS / 1000 }, CLI_TIMEOUT_MS + 5000), CLI_TIMEOUT_MS + 10000)
  if (res && res.blocked) throw new Error(res.hint || 'cli.exec blocked')
  return parseCliJson(String((res && res.output) || ''))
}
function viaRest(month, refresh) {
  const q = [`month=${month}`, TZ ? `tz=${encodeURIComponent(TZ)}` : '', refresh ? 'refresh=true' : ''].filter(Boolean).join('&')
  return pluginCtx.rest(`/month?${q}`, { timeoutMs: CLI_TIMEOUT_MS })
}
async function readMonth(month, refresh) {
  if (backend !== 'cli' && pluginCtx && typeof pluginCtx.rest === 'function') {
    try {
      const r = await viaRest(month, refresh)
      backend = 'rest'
      if (r && r.error) throw new Error(r.error)
      return r
    } catch (e) {
      if (backend === 'rest') throw e
      console.error(`[${ID}] backend REST unavailable (${String((e && e.message) || e)}); using the CLI`)
    }
  }
  const r = await viaCli(month, refresh)
  backend = 'cli'
  if (r.error) throw new Error(r.error)
  return r
}

// ── store ───────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0')
const monthOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const thisMonth = () => monthOf(new Date())
const shiftMonth = (m, by) => { const [y, mo] = m.split('-').map(Number); return monthOf(new Date(y, mo - 1 + by, 1)) }

const store = { months: {}, inflight: {}, errors: {}, view: thisMonth(), listeners: new Set() }
function emit() { store.listeners.forEach((fn) => fn()) }
function load(month, refresh) {
  if (store.inflight[month]) return store.inflight[month]
  store.inflight[month] = readMonth(month, refresh)
    .then((d) => { store.months[month] = d; delete store.errors[month]; if (month === thisMonth()) announce(d) })
    .catch((e) => { store.errors[month] = String((e && e.message) || e) })
    .finally(() => { delete store.inflight[month]; emit() })
  emit()
  return store.inflight[month]
}
function useStore() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    store.listeners.add(fn)
    return () => store.listeners.delete(fn)
  }, [])
  return store
}

// ── seen + notify ───────────────────────────────────────────────────────────
const SEEN_KEY = 'hermes-nous-calendar.seen-major.v1'
const OPENED_KEY = 'hermes-nous-calendar.opened-at.v1'
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* fine */ } }
function announce(d) {
  const majors = (d.drops || []).filter((x) => MAJOR.has(x.kind))
  let seen = lsGet(SEEN_KEY, null)
  const first = seen === null
  seen = new Set(seen || [])
  const fresh = majors.filter((x) => !seen.has(x.id))
  fresh.forEach((x) => seen.add(x.id))
  lsSet(SEEN_KEY, [...seen].slice(-500))
  if (first || !os || typeof os.notify !== 'function') return   // a brand-new viewer: record, don't notify
  fresh.slice(0, 3).forEach((x) => os.notify({ title: `Nous shipped · ${x.label}`, body: `${x.title}${x.detail ? ` — ${x.detail}` : ''}`, activate: ROUTE }))
}
const openedAt = () => lsGet(OPENED_KEY, 0)
function markOpened() { lsSet(OPENED_KEY, Date.now()); emit() }

function openLink(url) {
  if (!url) return
  if (os && typeof os.openExternal === 'function') {
    os.openExternal(url).then((ok) => { if (!ok) host.notify?.({ kind: 'error', message: `Couldn't open ${url}` }) })
  } else {
    window.open(url, '_blank', 'noopener')
  }
}
// The CLI fallback sends catalog additions without links (--compact keeps it under the output cap).
const catalogUrl = (name) => `https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/${name}.yaml`
const urlOf = (x) => x.url || (x.kind === 'catalog' || x.kind === 'official' ? catalogUrl(x.title) : '')

// ── helpers ─────────────────────────────────────────────────────────────────
const toNum = (v) => {
  if (typeof v === 'number') return v
  const m = String(v || '').trim().match(/^([\d.,]+)\s*([KkMm]?)$/)
  if (!m) return 0
  const n = parseFloat(m[1].replace(/,/g, ''))
  return Math.round(n * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1))
}
const fmtViews = (v) => { const n = toNum(v); return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : n ? String(n) : '' }
const fmtInt = (n) => (n || 0).toLocaleString()
const dateOf = (iso) => new Date(`${iso}T12:00:00`)
const fmtDay = (iso, opts) => dateOf(iso).toLocaleDateString(undefined, opts)
const fmtTime = (at) => { try { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { return '' } }
const monthName = (m) => dateOf(`${m}-15`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
// `code` spans inside an X headline
const inline = (text) => String(text || '').split('`').map((part, i) => (i % 2 ? jsx('code', { children: part }, i) : part))

// One day, merged from GitHub drops and the X feed.
function dayModel(iso, drops, xday, merged) {
  const kinds = new Set(drops.map((x) => x.kind))
  for (const t of (xday && xday.types) || []) kinds.add(t)
  const label = LABELS.find((l) => kinds.has(l.key))
  const releases = drops.filter((x) => x.kind === 'release')
  const big = (xday && xday.big) || []
  const topViews = big.length ? Math.max(...big.map((b) => toNum(b.views))) : 0
  let head = xday && xday.head ? xday.head : ''
  if (!head) {
    const pick = releases[releases.length - 1] || drops.find((x) => x.kind === 'official') || drops.find((x) => x.kind === 'feature') || drops.find((x) => x.kind === 'plugin-update')
    const cat = drops.filter((x) => x.kind === 'catalog').length
    head = pick ? pick.title : cat ? `${cat} new plugin${cat === 1 ? '' : 's'} in the catalog` : ''
  }
  const tags = (xday && xday.tags && xday.tags.length ? xday.tags : releases.map((r) => (r.id || '').replace(/^release:/, ''))).filter(Boolean)
  return { iso, drops, xday, merged: merged || 0, kinds, label, head, topViews, tags, releases,
    by: xday ? `${xday.by || 'Nous'}${xday.time ? ` · ${xday.time}` : ''}` : drops.length ? 'GitHub' : '' }
}

// ── look ────────────────────────────────────────────────────────────────────
const CSS = `
.nc{--ground:#f3f6fd;--paper:#fff;--ink:#0d0c0a;--slate:#3b4660;--muted:#6a7389;--faint:#a3abbd;--line:#d9e0ee;--soft:#eef2fb;--accent:#0a4cff;--rel-bg:#0d0c0a;--rel-fg:#fff;--rel-muted:#9aa3b5;--teal:#0d8a7a;--gold:#9a700e;--orange:#b4560c;
  --display:"NC Anton","Anton",Impact,"Arial Narrow",sans-serif;--body:"NC Instrument Sans","Instrument Sans",system-ui,sans-serif;--mono:"NC JetBrains Mono","JetBrains Mono",ui-monospace,monospace;
  position:relative;height:100%;overflow:hidden;background:var(--ground);color:var(--ink);font:15px/1.5 var(--body);container-type:inline-size;color-scheme:light}
.nc *{box-sizing:border-box}
.nc button{font:inherit;color:inherit}
.nc :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nc .scroller{height:100%;overflow:auto}
.nc .wrap{max-width:1240px;margin:0 auto;padding:22px clamp(14px,3vw,32px) 56px;display:grid;gap:22px}
.nc .topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.nc .by{font:500 12.5px var(--mono);color:var(--muted)}
.nc .by b{color:var(--ink)}
.nc .nav{display:flex;gap:6px;align-items:center}
.nc .ib{border:1px solid var(--line);background:var(--paper);border-radius:8px;min-width:34px;height:32px;padding:0 10px;cursor:pointer;font:700 12.5px var(--mono)}
.nc .ib:hover{background:var(--soft)}
.nc .ib:disabled{opacity:.35;cursor:default}
.nc .ib.dark{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.nc header{display:grid;gap:10px}
.nc .kicker{font:700 11.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.nc h1{font:400 clamp(40px,7cqi,84px)/.9 var(--display);text-transform:uppercase;margin:0;letter-spacing:.005em}
.nc h1 em{font-style:normal;color:var(--accent)}
.nc .lede{margin:0;color:var(--slate);max-width:64ch;font-size:16px}
.nc .lede b{color:var(--ink)}
.nc .figs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-block:1px solid var(--line)}
.nc .fig{padding:12px 14px 12px 0;display:grid;gap:2px;min-width:0}
.nc .fig + .fig{padding-left:14px;border-left:1px solid var(--line)}
.nc .fig .k{font:700 10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.nc .fig .v{font:400 32px/1.05 var(--display);font-variant-numeric:tabular-nums}
.nc .fig .v.acc{color:var(--accent)}
.nc .fig .v small{color:var(--faint);font-size:inherit}
.nc .fig .s{font:500 12px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nc .toolbar{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;justify-content:space-between}
.nc .filters{display:flex;flex-wrap:wrap;gap:4px 16px}
.nc .filter{border:0;background:none;padding:4px 0;font:600 13.5px var(--body);color:var(--muted);cursor:pointer;border-bottom:2px solid transparent}
.nc .filter[aria-pressed="true"]{color:var(--ink);border-bottom-color:var(--ink)}
.nc .hint{font:500 12px var(--mono);color:var(--muted)}
.nc .warn{font:500 12px var(--mono);color:var(--orange)}
.nc .err{font:500 13px var(--body);color:#b42318}
.nc .cal{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--paper)}
.nc .dows{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-bottom:1px solid var(--line);background:var(--soft)}
.nc .dows span{font:700 10.5px var(--mono);letter-spacing:.16em;color:var(--muted);padding:8px 12px}
.nc .grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.nc .day{position:relative;text-align:left;border:0;background:transparent;border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 12px 16px;display:grid;grid-template-rows:auto auto 1fr auto;gap:6px;min-height:176px;cursor:pointer;overflow:hidden;min-width:0}
.nc .day:nth-child(7n){border-right:0}
.nc .day:hover{background:var(--soft)}
.nc .day.blank{cursor:default;background:var(--ground)}
.nc .day.blank:hover{background:var(--ground)}
.nc .date{display:flex;align-items:baseline;gap:8px}
.nc .num{font:400 38px/.9 var(--display);font-variant-numeric:tabular-nums;color:var(--ink)}
.nc .dl{font:700 10px/1.25 var(--mono);letter-spacing:.12em;color:var(--muted);text-transform:uppercase}
.nc .lab{font:700 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;display:flex;gap:8px;align-items:baseline;color:var(--muted);min-height:14px;min-width:0}
.nc .t-release{color:var(--ink)}.nc .t-launch{color:var(--accent)}.nc .t-model{color:var(--teal)}.nc .t-news{color:var(--gold)}.nc .t-feature{color:var(--slate)}.nc .t-update{color:var(--orange)}.nc .t-catalog{color:var(--teal)}.nc .t-build{color:var(--muted)}
.nc .ver{font:500 11px var(--mono);color:var(--slate);text-transform:none;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nc .head{font:600 14px/1.32 var(--body);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.nc .head code,.nc .sheet code{font:600 .9em var(--mono);background:var(--soft);padding:0 4px;border-radius:4px}
.nc .foot{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font:500 10.5px var(--mono);color:var(--muted);white-space:nowrap;min-width:0}
.nc .foot span{overflow:hidden;text-overflow:ellipsis}
.nc .foot b{font:700 12px var(--mono);color:var(--ink);font-variant-numeric:tabular-nums}
.nc .pr{position:absolute;left:0;bottom:0;height:3px;background:var(--accent);opacity:.35}
.nc .day.launch .num{color:var(--accent)}
.nc .day.quiet .head{color:var(--slate);font-weight:500}
.nc .day.release{background:var(--rel-bg);color:var(--rel-fg)}
.nc .day.release:hover{background:var(--rel-bg);filter:brightness(1.15)}
.nc .day.release .num,.nc .day.release .head,.nc .day.release .foot b,.nc .day.release .t-release{color:var(--rel-fg)}
.nc .day.release .dl,.nc .day.release .foot,.nc .day.release .ver{color:var(--rel-muted)}
.nc .day.release .pr{background:var(--rel-fg)}
.nc .day.release .head code{background:#ffffff22}
.nc .day.today{box-shadow:inset 0 0 0 2px var(--accent)}
.nc .day.today .dl::after{content:" · today";color:var(--accent)}
.nc .day.dim{opacity:.22}
.nc .day.up{cursor:default;background:repeating-linear-gradient(135deg,transparent 0 10px,var(--soft) 10px 11px)}
.nc .day.up .num{color:var(--faint)}
.nc .day.up .head{color:var(--faint);font-weight:500;font-size:13px}
.nc .day.sel{box-shadow:inset 0 0 0 2px var(--ink)}
.nc .day.shine::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.3) 50%,transparent 65%);transform:translateX(-120%);animation:nc-shine 1.6s .5s ease-out 1 forwards;pointer-events:none}
@keyframes nc-shine{to{transform:translateX(120%)}}
@media (prefers-reduced-motion:reduce){.nc .day.shine::after{animation:none;display:none}}
@container (max-width:1000px){.nc .grid{grid-template-columns:repeat(4,minmax(0,1fr))}.nc .dows,.nc .day.blank{display:none}.nc .day:nth-child(7n){border-right:1px solid var(--line)}.nc .day:nth-child(4n){border-right:0}.nc .figs{grid-template-columns:repeat(3,minmax(0,1fr))}.nc .fig:nth-child(4){padding-left:0;border-left:0}.nc .fig:nth-child(n+4){border-top:1px solid var(--line)}}
@container (max-width:600px){.nc .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.nc .day:nth-child(4n){border-right:1px solid var(--line)}.nc .day:nth-child(2n){border-right:0}.nc .figs{grid-template-columns:repeat(2,minmax(0,1fr))}.nc .fig:nth-child(odd){padding-left:0;border-left:0}.nc .fig:nth-child(4){padding-left:14px;border-left:1px solid var(--line)}.nc .fig:nth-child(n+3){border-top:1px solid var(--line)}}
.nc .legend{display:flex;flex-wrap:wrap;gap:6px 18px;font:500 12px var(--mono);color:var(--muted);align-items:center}
.nc .legend span{display:inline-flex;gap:7px;align-items:center}
.nc .legend svg{width:14px;height:14px}
.nc .foot-note{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font:500 12px var(--mono);color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
.nc .scrim{position:absolute;inset:0;background:rgba(13,16,28,.45);z-index:5}
.nc .sheet{position:absolute;right:0;top:0;bottom:0;width:min(580px,100%);background:var(--paper);box-shadow:0 24px 60px rgba(13,22,48,.2);display:flex;flex-direction:column;border-left:1px solid var(--line);z-index:6}
.nc .sh-top{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 18px;border-bottom:1px solid var(--line)}
.nc .sh-body{overflow:auto;padding:20px 20px 32px;display:grid;gap:22px;align-content:start}
.nc .sh-date{display:flex;align-items:baseline;gap:12px}
.nc .sh-date .num{font-size:56px}
.nc .sh-sec{display:grid;gap:8px}
.nc .sh-sec h3{margin:0;font:700 11px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);display:flex;gap:8px;align-items:center}
.nc .sh-sec h3 svg{width:14px;height:14px}
.nc .sh-sec h3 b{color:var(--ink)}
.nc .bul{margin:0;padding-left:18px;display:grid;gap:4px;font:600 15px/1.4 var(--body)}
.nc .bul a{color:var(--accent);text-decoration:none;border-bottom:1px solid currentColor}
.nc .row{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;cursor:pointer;text-align:left;background:var(--paper)}
.nc .row:hover{background:var(--soft)}
.nc .row b{font:600 13.5px/1.35 var(--body)}
.nc .row small{grid-column:1/-1;font:500 11.5px var(--mono);color:var(--muted)}
.nc .row em{font:700 12px var(--mono);font-style:normal;color:var(--ink);white-space:nowrap}
.nc .row p{grid-column:1/-1;margin:0;font:400 13px/1.45 var(--body);color:var(--slate)}
.nc .chips{display:flex;flex-wrap:wrap;gap:5px}
.nc .chip{font:500 11.5px var(--mono);padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:var(--paper);cursor:pointer}
.nc .chip:hover{border-color:var(--accent);color:var(--accent)}
.nc .muted{color:var(--muted);font:500 12.5px var(--mono)}
`

// Thin line icons for the legend and sheet headings (no emoji).
const ICON = {
  release: 'M3 8h10M8 3v10', launch: 'M3 13L13 3M7 3h6v6', official: 'M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4L2.2 6.3l4-.6z',
  model: 'M3 5h10v6H3zM6 11v2M10 11v2', news: 'M3 3h8v10H3zM11 6h2v6a1 1 0 01-2 0', feature: 'M3 8a5 5 0 1010 0A5 5 0 003 8zM8 5v6M5 8h6',
  'plugin-update': 'M4 8a4 4 0 017-2.6M12 8a4 4 0 01-7 2.6M11 3v3h-3M5 13v-3h3', catalog: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
}
const LEG_COLOR = { release: 'var(--ink)', launch: 'var(--accent)', official: 'var(--accent)', model: 'var(--teal)', news: 'var(--gold)', feature: 'var(--slate)', 'plugin-update': 'var(--orange)', catalog: 'var(--teal)' }
const icon = (k) => jsx('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: LEG_COLOR[k] || 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, children: jsx('path', { d: ICON[k] || ICON.feature }) })

// ── page ────────────────────────────────────────────────────────────────────
function DayCell({ m, today, future, dim, selected, maxMerged, onPick }) {
  const n = Number(m.iso.slice(8))
  const isRel = m.kinds.has('release')
  const isLaunch = !isRel && (m.kinds.has('launch') || m.kinds.has('official'))
  const quiet = !m.xday && !isRel && !m.kinds.has('official')
  const cls = ['day', isRel ? 'release' : '', isLaunch ? 'launch' : '', quiet ? 'quiet' : '', m.iso === today ? 'today' : '', future ? 'up' : '', dim ? 'dim' : '', selected ? 'sel' : '',
    !future && (isRel || m.topViews >= SHINE_VIEWS) ? 'shine' : ''].filter(Boolean).join(' ')
  const right = m.topViews ? jsx('b', { children: fmtViews(m.topViews) }) : m.merged ? h('span', null, `${m.merged} PRs`) : null
  return h('button', {
    type: 'button', className: cls, disabled: future, onClick: () => onPick(m.iso),
    'aria-label': `${fmtDay(m.iso, { weekday: 'long', month: 'long', day: 'numeric' })}${m.label ? `: ${m.label.word}` : ''}`,
  },
  h('div', { className: 'date' }, h('span', { className: 'num' }, pad(n)), h('span', { className: 'dl' }, fmtDay(m.iso, { weekday: 'short' }), jsx('br', {}), fmtDay(m.iso, { month: 'short' }))),
  h('div', { className: 'lab' }, m.label && !future ? h('span', { className: m.label.cls }, m.label.word) : null, isRel && m.tags.length ? h('span', { className: 'ver' }, m.tags.join(' · ')) : null),
  h('div', { className: 'head' }, future ? 'Awaiting drop' : m.head ? inline(m.head) : 'No drops'),
  future ? null : h('div', { className: 'foot' }, h('span', null, m.by), right),
  !future && m.merged ? jsx('span', { className: 'pr', style: { width: `${Math.max(6, Math.round((m.merged / (maxMerged || 1)) * 100))}%` } }) : null)
}

const CATALOG_FOLD = 30
function DaySheet({ m, onClose, onStep, canPrev, canNext }) {
  const [all, setAll] = useState(false)
  useEffect(() => setAll(false), [m.iso])
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowLeft' && canPrev) onStep(-1); if (e.key === 'ArrowRight' && canNext) onStep(1) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [m.iso, canPrev, canNext])
  const x = m.xday
  const of = (k) => m.drops.filter((d) => d.kind === k)
  const sec = (k, title, items, body) => (items && items.length ? h('section', { className: 'sh-sec', key: k }, h('h3', null, icon(k), title, h('b', null, String(items.length))), body) : null)
  const row = (d, extra) => jsx('button', { type: 'button', className: 'row', title: urlOf(d), onClick: () => openLink(urlOf(d)),
    children: [jsx('b', { children: inline(d.title) }, 'b'), jsx('em', { children: extra || fmtTime(d.at) }, 'e'), d.detail ? jsx('small', { children: d.detail }, 's') : null] }, d.id)
  const cat = of('catalog')
  return h('div', null,
    jsx('div', { className: 'scrim', onClick: onClose }),
    h('aside', { className: 'sheet', role: 'dialog', 'aria-label': `Drops for ${fmtDay(m.iso, { month: 'long', day: 'numeric' })}` },
      h('div', { className: 'sh-top' },
        h('div', { className: 'nav' },
          h('button', { type: 'button', className: 'ib', onClick: () => onStep(-1), disabled: !canPrev, 'aria-label': 'Previous day' }, '←'),
          h('button', { type: 'button', className: 'ib', onClick: () => onStep(1), disabled: !canNext, 'aria-label': 'Next day' }, '→')),
        h('button', { type: 'button', className: 'ib', onClick: onClose }, 'Close')),
      h('div', { className: 'sh-body' },
        h('div', { className: 'sh-date' }, h('span', { className: 'num' }, pad(Number(m.iso.slice(8)))),
          h('div', null, h('div', { className: 'kicker' }, m.label ? m.label.word : 'Quiet day'), h('div', { className: 'muted' }, fmtDay(m.iso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })))),
        x ? h('section', { className: 'sh-sec' },
          h('h3', null, icon('launch'), 'On X', h('span', null, `${x.by || 'Nous'}${x.time ? ` · ${x.time} PT` : ''}`)),
          h('ul', { className: 'bul' }, ...String(x.head || '').split(' · ').map((part, i) => jsx('li', { children: i === 0 && x.url ? jsx('a', { href: x.url, onClick: (e) => { e.preventDefault(); openLink(x.url) }, children: inline(part) }) : inline(part) }, i)))) : null,
        sec('release', 'Released', of('release'), h('div', { className: 'sh-sec' }, ...of('release').map((d) => row(d)))),
        x && x.big && x.big.length ? sec('news', 'Biggest posts', x.big, h('div', { className: 'sh-sec' }, ...x.big.map((b, i) => jsx('button', { type: 'button', className: 'row', onClick: () => openLink(b.url),
          children: [jsx('b', { children: `@${b.author}` }, 'a'), jsx('em', { children: `${fmtViews(b.views)} views` }, 'v'), b.text ? jsx('p', { children: b.text }, 't') : null, b.time ? jsx('small', { children: `${b.time} PT` }, 's') : null] }, `big${i}`)))) : null,
        sec('official', 'Official plugins', of('official'), h('div', { className: 'sh-sec' }, ...of('official').map((d) => row(d, 'catalog')))),
        sec('feature', 'Features merged on main', of('feature'), h('div', { className: 'sh-sec' }, ...of('feature').map((d) => row(d)))),
        x && x.team && x.team.length ? sec('model', 'Team posts', x.team, h('div', { className: 'sh-sec' }, ...x.team.map((t, i) => jsx('button', { type: 'button', className: 'row', onClick: () => openLink(t.url),
          children: [jsx('b', { children: `@${t.author}${t.repost ? ' · repost' : ''}` }, 'a'), jsx('em', { children: t.time ? `${t.time} PT` : '' }, 'v'), t.text ? jsx('p', { children: t.text }, 't') : null] }, `team${i}`)))) : null,
        sec('plugin-update', 'Official plugin updates', of('plugin-update'), h('div', { className: 'sh-sec' }, ...of('plugin-update').map((d) => row(d)))),
        sec('catalog', 'New in the catalog', cat, h('div', { className: 'chips' },
          ...(all ? cat : cat.slice(0, CATALOG_FOLD)).map((d) => jsx('button', { type: 'button', className: 'chip', title: d.detail || d.title, onClick: () => openLink(urlOf(d)), children: d.title }, d.id)),
          cat.length > CATALOG_FOLD && !all ? jsx('button', { type: 'button', className: 'chip', onClick: () => setAll(true), children: `Show all ${cat.length}` }, 'more') : null)),
        h('section', { className: 'sh-sec' }, h('h3', null, 'Merged PRs', h('b', null, fmtInt(m.merged))),
          h('div', { className: 'muted' }, 'Every pull request merged into NousResearch/hermes-agent that day, counted, not listed.')))))
}

function CalendarPage() {
  const s = useStore()
  const [filter, setFilter] = useState(() => lsGet('hermes-nous-calendar.filter.v2', 'all'))
  const [pick, setPick] = useState(null)
  const month = s.view
  const d = s.months[month]
  useEffect(() => { if (!s.months[month] && !s.inflight[month]) load(month) }, [month])
  useEffect(() => { markOpened() }, [])
  const choose = (f) => { setFilter(f); lsSet('hermes-nous-calendar.filter.v2', f) }
  const go = (by) => { s.view = shiftMonth(month, by); setPick(null); emit() }
  const loading = Boolean(s.inflight[month])
  const today = (d && d.today) || new Date().toISOString().slice(0, 10)

  const [y, mo] = month.split('-').map(Number)
  const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7          // Monday first
  const count = new Date(y, mo, 0).getDate()
  const isos = Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`)
  const xdays = (d && d.x && d.x.days) || {}
  const byDay = {}
  for (const x of (d && d.drops) || []) (byDay[x.day] = byDay[x.day] || []).push(x)
  const models = Object.fromEntries(isos.map((iso) => [iso, dayModel(iso, byDay[iso] || [], xdays[iso], d && d.merged ? d.merged[iso] : 0)]))
  const maxMerged = Math.max(1, ...isos.map((iso) => models[iso].merged))
  const past = isos.filter((iso) => iso <= today)
  const active = past.filter((iso) => models[iso].drops.length || models[iso].xday)
  const rel = ((d && d.drops) || []).filter((x) => x.kind === 'release')
  const ver = (r) => (r.title.match(/v[\d.]+/) || [r.title])[0]
  const totalPRs = isos.reduce((a, iso) => a + models[iso].merged, 0)
  const launchDays = past.filter((iso) => models[iso].kinds.has('launch') || models[iso].kinds.has('official')).length
  const bigPosts = Object.values(xdays).reduce((a, v) => a + ((v.big || []).length), 0)
  const topBig = Math.max(0, ...Object.values(xdays).flatMap((v) => (v.big || []).map((b) => toNum(b.views))))
  const step = (by) => { const i = past.indexOf(pick); const nx = past[i + by]; if (nx) setPick(nx) }

  const figs = d ? [
    ['Days', h('span', null, String(active.length), h('small', null, `/${past.length}`)), 'with a drop', ''],
    ['Releases', String(rel.length), rel.length ? `${ver(rel[0])} → ${ver(rel[rel.length - 1])}` : 'none yet', ''],
    ['Launch days', String(launchDays), `${(d.counts || {}).official || 0} official plugins · ${(d.counts || {}).feature || 0} features`, 'acc'],
    d.x ? ['Big posts', String(bigPosts), bigPosts ? `50K+ views · top ${fmtViews(topBig)}` : 'none this month', '']
      : ['New in catalog', fmtInt((d.counts || {}).catalog || 0), `${(d.counts || {})['plugin-update'] || 0} official-plugin updates`, ''],
    ['PRs merged', fmtInt(totalPRs), 'NousResearch/hermes-agent', 'acc'],
  ] : []
  const xerr = d && d.x && d.x.error
  return h('div', { className: 'nc' },
    jsx('style', { children: fontFaces() + CSS }),
    h('div', { className: 'scroller' }, h('div', { className: 'wrap' },
      h('div', { className: 'topbar' },
        h('div', { className: 'by' }, 'Nous Calendar · independent tracker by ', h('b', null, '@BkashJosi')),
        h('div', { className: 'nav' },
          h('button', { type: 'button', className: 'ib', onClick: () => go(-1), 'aria-label': 'Previous month' }, '←'),
          h('button', { type: 'button', className: 'ib', onClick: () => go(1), disabled: month >= thisMonth(), 'aria-label': 'Next month' }, '→'),
          month !== thisMonth() ? h('button', { type: 'button', className: 'ib', onClick: () => { s.view = thisMonth(); setPick(null); emit() } }, 'This month') : null,
          h('button', { type: 'button', className: 'ib dark', onClick: () => load(month, true), disabled: loading }, loading ? 'Reading…' : 'Check now'))),
      h('header', null,
        h('div', { className: 'kicker' }, `What Nous shipped · ${monthName(month)}`),
        h('h1', null, 'Hermes ', jsx('em', { children: 'Daily Drops' })),
        h('p', { className: 'lede' }, 'What ', h('b', null, '@NousResearch'), d && d.x ? [' and ', jsx('b', { children: '@Teknium' }, 't'), ' shipped each day: releases, official plugins and features from GitHub, and the biggest posts on X.'] : ' shipped for Hermes Agent each day: releases, official plugins, features and new catalog plugins, straight from GitHub.')),
      d ? h('div', { className: 'figs' }, ...figs.map(([k, v, sub, cls]) => jsx('div', { className: 'fig', children: [jsx('span', { className: 'k', children: k }, 'k'), jsx('span', { className: `v ${cls || ''}`, children: v }, 'v'), jsx('span', { className: 's', children: sub }, 's')] }, k))) : null,
      h('div', { className: 'toolbar' },
        h('div', { className: 'filters', role: 'group', 'aria-label': 'Show' }, ...FILTERS.map(([k, label]) => jsx('button', { type: 'button', className: 'filter', 'aria-pressed': filter === k, onClick: () => choose(k), children: label }, k))),
        h('div', { className: 'hint' }, d ? `Updated ${new Date((d.generated || 0) * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${d.x && d.x.updated ? ` · X through ${fmtDay(d.x.updated, { month: 'short', day: 'numeric' })}` : ''} · tap a day` : loading ? 'Reading GitHub… the first read of a month can take a minute' : '')),
      s.errors[month] && !d ? h('div', { className: 'err' }, `Could not read the calendar: ${s.errors[month].slice(0, 300)}. Fix: hermes plugins enable hermes-nous-calendar, then restart Hermes Desktop.`) : null,
      d && Object.keys(d.errors || {}).length ? h('div', { className: 'warn' }, `Couldn't read: ${Object.entries(d.errors).map(([k, v]) => `${k} (${v})`).join(' · ')}`) : null,
      d && d.auth === 'anonymous' ? h('div', { className: 'warn' }, 'Not signed in to GitHub: catalog additions come from commit messages and merged-PR counts are off. Run `gh auth login` for exact data.') : null,
      xerr ? h('div', { className: 'warn' }, `On X layer unavailable right now (${xerr}). GitHub drops still show.`) : null,
      d ? h('div', { className: 'cal' },
        h('div', { className: 'dows' }, ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => jsx('span', { children: w.toUpperCase() }, w))),
        h('div', { className: 'grid' },
          ...Array.from({ length: lead }, (_, i) => jsx('div', { className: 'day blank', 'aria-hidden': true }, `b${i}`)),
          ...isos.map((iso) => jsx(DayCell, { m: models[iso], today, future: iso > today, maxMerged, selected: pick === iso,
            dim: filter !== 'all' && !models[iso].kinds.has(filter) && !(filter === 'launch' && models[iso].kinds.has('official')), onPick: setPick }, iso)))) : null,
      d ? h('div', { className: 'legend' }, ...['release', 'launch', 'official', 'model', 'news', 'feature', 'plugin-update', 'catalog'].map((k) => jsx('span', { children: [icon(k), (LABELS.find((l) => l.key === k) || {}).word] }, k)),
        jsx('span', { children: [jsx('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, children: jsx('rect', { x: 1, y: 11, width: 14, height: 3, fill: 'var(--accent)', opacity: 0.35 }) }, 'i'), 'Bar: merged PRs that day'] }, 'pr')) : null,
      d ? h('div', { className: 'foot-note' },
        h('span', null, `GitHub: NousResearch/hermes-agent and hermes-official-plugins · days in ${d.tz}`),
        h('span', null, d.x ? 'X drops curated by @BkashJosi · independent, not affiliated with Nous Research' : 'Independent, not affiliated with Nous Research')) : null)),
    pick && models[pick] ? jsx(DaySheet, { m: models[pick], onClose: () => setPick(null), onStep: step, canPrev: past.indexOf(pick) > 0, canNext: past.indexOf(pick) < past.length - 1 }) : null)
}

function StatusChip() {
  const s = useStore()
  const d = s.months[thisMonth()]
  if (!d) return null
  const since = openedAt()
  const fresh = (d.drops || []).filter((x) => COUNTED.has(x.kind) && Date.parse(x.at) > since)
  const major = fresh.some((x) => MAJOR.has(x.kind))
  return jsx('button', {
    type: 'button', title: 'Open Nous Calendar', onClick: () => host.navigate(ROUTE),
    style: { background: 'transparent', border: 0, cursor: 'pointer', padding: '0 6px', fontSize: 11, fontFamily: 'ui-monospace,monospace', color: major ? '#4a84fe' : fresh.length ? 'var(--ui-text-primary,#e6edf3)' : 'var(--ui-text-tertiary,#a6a4b0)' },
    children: fresh.length ? `☤ ${fresh.length} new drop${fresh.length === 1 ? '' : 's'}` : '☤ up to date',
  })
}

function startPolling(ctx) {
  const tick = () => { if (!document.hidden) load(thisMonth()) }
  load(thisMonth())
  ctx.setInterval(tick, REFRESH_MS)
}

export default {
  id: ID,
  name: 'Nous Calendar',
  register(ctx) {
    os = ctx.os || null
    pluginCtx = ctx
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(CalendarPage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, order: 87, data: { path: ROUTE, label: 'Nous Calendar', codicon: 'calendar' } })
    ctx.register({ id: 'open', area: PALETTE_AREA, data: { id: `${ID}.open`, label: 'Open Nous Calendar', keywords: ['nous', 'calendar', 'release', 'changelog', 'drops', 'daily drops', 'what shipped', 'catalog'], run: () => host.navigate(ROUTE) } })
    ctx.register({ id: 'statusbar', area: STATUSBAR_AREAS.right, order: 132, render: () => jsx(StatusChip, {}) })
    startPolling(ctx)
  },
}
