// hermes-nous-calendar: desktop half. Plain ESM, loaded uncompiled by Hermes Desktop (no JSX, no build).
//
// Surfaces: route /nous-calendar (sidebar row "Nous Calendar" + ⌘K "Open Nous Calendar") and a
// status-bar chip that counts drops since you last opened the page.
// Data: the plugin's own backend first, ctx.rest('/month?month=…&tz=…') -> dashboard/plugin_api.py.
//       If it isn't mounted, the CLI through the local gateway: `hermes nous-calendar --json --compact`.
// Alerts: one desktop notification per NEW release or official plugin (never on the first visit).
// Look: theme variables only (--ui-*), plus one fixed colour per kind of drop.

import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-nous-calendar'
const ROUTE = '/nous-calendar'
const REFRESH_MS = 30 * 60000
const CLI_TIMEOUT_MS = 240000
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } })()
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace'

// One colour per kind, in the order a day reads them.
const KINDS = [
  { key: 'release', label: 'Release', short: 'Release', color: '#e3b341' },
  { key: 'official', label: 'Official plugin', short: 'Official', color: '#4a84fe' },
  { key: 'feature', label: 'Feature', short: 'Feature', color: '#bc8cff' },
  { key: 'plugin-update', label: 'Official plugin update', short: 'Update', color: '#ffa657' },
  { key: 'catalog', label: 'New in catalog', short: 'Catalog', color: '#39c5cf' },
]
const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k]))
const MAJOR = new Set(['release', 'official'])
const COUNTED = new Set(['release', 'official', 'feature'])   // what the "new drops" chip counts

// h('div', {className}, child, child…): jsx/jsxs without JSX.
const h = (type, props, ...children) => (children.length > 1 ? jsxs : jsx)(type, { ...(props || {}), children: children.length === 1 ? children[0] : children })

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
function openedAt() { return lsGet(OPENED_KEY, 0) }
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

// ── page ────────────────────────────────────────────────────────────────────
const CSS = `
.nc{height:100%;display:flex;flex-direction:column;overflow:hidden;min-height:0;container-type:inline-size;color:var(--ui-text-primary,#eeedf2);background:var(--background,#141419);font:14px/1.5 system-ui,sans-serif;box-sizing:border-box}
.nc *{box-sizing:border-box}
.nc .head{flex-shrink:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:22px clamp(16px,3vw,36px) 12px;border-bottom:1px solid var(--ui-stroke-tertiary,#34343b)}
.nc h1{margin:0;font-size:21px;font-weight:700;letter-spacing:-.01em}
.nc .sub{font-size:12px;color:var(--ui-text-tertiary,#a6a4b0)}
.nc .nav{margin-left:auto;display:flex;align-items:center;gap:6px}
.nc .nav b{font:600 13px ${MONO};min-width:118px;text-align:center}
.nc button{font:12px system-ui,sans-serif;padding:5px 11px;border-radius:7px;border:1px solid var(--ui-stroke-tertiary,#34343b);background:var(--ui-bg-quaternary,#24242b);color:inherit;cursor:pointer}
.nc button:hover{border-color:var(--ui-stroke-primary,#64616f)}
.nc button:disabled{opacity:.5;cursor:default}
.nc .stats{display:flex;gap:8px;flex-wrap:wrap;width:100%}
.nc .stat{display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:9px;border:1px solid var(--ui-stroke-tertiary,#34343b);background:var(--ui-bg-tertiary,#0d1117);font-size:11.5px;color:var(--ui-text-secondary,#b8b6c2);cursor:pointer;user-select:none}
.nc .stat b{font:700 15px ${MONO};color:var(--k)}
.nc .stat.off{opacity:.4}
.nc .dot{width:8px;height:8px;border-radius:50%;background:var(--k);flex:none}
.nc .scroll{flex:1;overflow:auto;padding:14px clamp(16px,3vw,36px) 36px}
.nc .scroll::-webkit-scrollbar{width:9px}.nc .scroll::-webkit-scrollbar-thumb{background:var(--ui-stroke-tertiary,#34343b);border-radius:8px}
.nc .wk{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin-bottom:6px;font:600 10.5px ${MONO};letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary,#6e7681);padding:0 4px}
.nc .grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.nc .cell{position:relative;min-height:122px;padding:8px 9px;border-radius:10px;border:1px solid var(--ui-stroke-quaternary,#2c2b34);background:var(--ui-bg-tertiary,#0d1117);display:flex;flex-direction:column;gap:5px;cursor:pointer;outline:none;transition:border-color .15s,transform .15s}
.nc .cell:hover{border-color:var(--ui-stroke-primary,#64616f);transform:translateY(-1px)}
.nc .cell:focus-visible{box-shadow:0 0 0 2px var(--ui-accent,#4a84fe)}
.nc .cell.blank{visibility:hidden}
.nc .cell.quiet{opacity:.55}
.nc .cell.future{opacity:.38;cursor:default;transform:none;border-style:dashed}
.nc .cell.today{border:1.5px solid #e3b341;box-shadow:0 0 18px -6px #e3b34199}
.nc .cell.sel{border-color:var(--ui-accent,#4a84fe);box-shadow:0 0 0 1px var(--ui-accent,#4a84fe)}
.nc .cell.hot{background:linear-gradient(160deg,color-mix(in srgb,var(--k) 14%,var(--ui-bg-tertiary,#0d1117)),var(--ui-bg-tertiary,#0d1117) 70%)}
.nc .ctop{display:flex;align-items:baseline;gap:6px}
.nc .ctop b{font:700 13px ${MONO}}
.nc .ctop span{font:10px ${MONO};color:var(--ui-text-quaternary,#6e7681);text-transform:uppercase;letter-spacing:.06em}
.nc .ctop i{margin-left:auto;font:700 9px ${MONO};font-style:normal;letter-spacing:.08em;color:#1d1206;background:#e3b341;padding:1px 6px;border-radius:999px}
.nc .badges{display:flex;flex-wrap:wrap;gap:4px}
.nc .badge{font:600 9.5px ${MONO};letter-spacing:.03em;padding:1px 6px;border-radius:999px;color:var(--k);border:1px solid color-mix(in srgb,var(--k) 55%,transparent);background:color-mix(in srgb,var(--k) 12%,transparent);white-space:nowrap}
.nc .lead{font-size:11.5px;line-height:1.4;color:var(--ui-text-secondary,#b8b6c2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.nc .lead.big{color:var(--ui-text-primary,#eeedf2);font-weight:600}
.nc .merged{margin-top:auto;font:10px ${MONO};color:var(--ui-text-quaternary,#6e7681)}
.nc .panel{margin-top:16px;border:1px solid var(--ui-stroke-tertiary,#34343b);border-radius:12px;background:var(--ui-bg-elevated,#010409);padding:16px 18px}
.nc .panel h2{margin:0 0 2px;font-size:16px}
.nc .panel .pm{font:11px ${MONO};color:var(--ui-text-quaternary,#6e7681);margin-bottom:10px}
.nc .sec{margin-top:12px}
.nc .sec h3{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:12px;font-weight:600;color:var(--k)}
.nc .sec h3 span{color:var(--ui-text-quaternary,#6e7681);font-weight:400}
.nc .item{display:flex;gap:10px;align-items:baseline;padding:5px 8px;border-radius:7px;cursor:pointer}
.nc .item:hover{background:var(--chrome-action-hover,#303038)}
.nc .item b{font-weight:600;font-size:13px}
.nc .item small{font-size:11.5px;color:var(--ui-text-tertiary,#a6a4b0)}
.nc .item em{margin-left:auto;font:10.5px ${MONO};font-style:normal;color:var(--ui-text-quaternary,#6e7681);white-space:nowrap}
.nc .chips{display:flex;flex-wrap:wrap;gap:5px}
.nc .chip{font:11px ${MONO};padding:2px 8px;border-radius:6px;border:1px solid var(--ui-stroke-tertiary,#34343b);color:var(--ui-text-secondary,#b8b6c2);cursor:pointer;background:transparent}
.nc .chip:hover{border-color:var(--k);color:var(--ui-text-primary,#eeedf2)}
.nc .legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:18px;font-size:11px;color:var(--ui-text-tertiary,#a6a4b0)}
.nc .legend span{display:flex;align-items:center;gap:6px}
.nc .note{margin-top:8px;font-size:11px;color:var(--ui-text-quaternary,#6e7681);line-height:1.6}
.nc .warn{font-size:11.5px;color:var(--ui-orange,#ffa657);margin-bottom:10px}
.nc .err{color:var(--ui-red,#ff7b72);font-size:12.5px}
.nc .list{display:none}
@container (max-width:760px){
  .nc .wk,.nc .grid{display:none}
  .nc .list{display:flex;flex-direction:column;gap:8px}
  .nc .list .cell{min-height:0}
  .nc .nav{margin-left:0;width:100%}
}
@media (prefers-reduced-motion:reduce){.nc .cell{transition:none}}
`

const fmtDay = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts)
const fmtTime = (at) => { try { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { return '' } }
const fmtMonth = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

function byDay(drops, hidden) {
  const out = {}
  for (const x of drops || []) if (!hidden.has(x.kind)) (out[x.day] = out[x.day] || []).push(x)
  return out
}
// The line a day cell leads with: a release, else an official plugin, else the first feature…
function leadOf(list) {
  for (const k of KINDS) {
    const hit = list.filter((x) => x.kind === k.key)
    if (!hit.length) continue
    if (k.key === 'catalog') return { kind: k.key, text: `${hit.length} new plugin${hit.length === 1 ? '' : 's'} in the catalog` }
    const top = k.key === 'release' ? hit[hit.length - 1] : hit[0]   // the newest release leads
    return { kind: k.key, text: top.title + (hit.length > 1 ? ` (+${hit.length - 1})` : '') }
  }
  return null
}

function DayCell({ iso, list, merged, today, future, selected, onPick }) {
  const n = Number(iso.slice(8))
  const wd = fmtDay(iso, { weekday: 'short' })
  const lead = leadOf(list)
  const counts = KINDS.map((k) => [k, list.filter((x) => x.kind === k.key).length]).filter(([, c]) => c)
  const cls = ['cell', today ? 'today' : '', future ? 'future' : '', selected ? 'sel' : '', !future && !list.length ? 'quiet' : '', lead && MAJOR.has(lead.kind) ? 'hot' : ''].filter(Boolean).join(' ')
  return h('div', {
    className: cls, role: 'button', tabIndex: future ? -1 : 0, style: lead ? { '--k': KIND[lead.kind].color } : undefined,
    'aria-label': `${fmtDay(iso, { weekday: 'long', month: 'long', day: 'numeric' })}: ${list.length} drops`,
    onClick: future ? undefined : () => onPick(iso),
    onKeyDown: (e) => { if (!future && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(iso) } },
  },
  h('div', { className: 'ctop' }, h('b', null, `${n}`), h('span', null, wd), today ? h('i', null, 'TODAY') : null),
  counts.length ? h('div', { className: 'badges' }, ...counts.map(([k, c]) => jsx('span', { className: 'badge', style: { '--k': k.color }, children: c > 1 || k.key === 'catalog' ? `${c} ${k.short}` : k.short }, k.key))) : null,
  future ? h('div', { className: 'lead' }, 'Upcoming') : lead ? h('div', { className: `lead${MAJOR.has(lead.kind) ? ' big' : ''}` }, lead.text) : h('div', { className: 'lead' }, 'No drops'),
  merged ? h('div', { className: 'merged' }, `${merged} merged PRs`) : null)
}

const CATALOG_FOLD = 24
function DayPanel({ iso, list, merged, onClose }) {
  const [all, setAll] = useState(false)
  const [el, setEl] = useState(null)
  useEffect(() => setAll(false), [iso])
  useEffect(() => { if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [el, iso])
  return h('div', { className: 'panel', ref: setEl },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
      h('h2', null, fmtDay(iso, { weekday: 'long', month: 'long', day: 'numeric' })),
      h('button', { type: 'button', style: { marginLeft: 'auto' }, onClick: onClose }, 'Close')),
    h('div', { className: 'pm' }, `${list.length} drop${list.length === 1 ? '' : 's'}${merged ? ` · ${merged} merged PRs that day` : ''}`),
    list.length ? null : h('div', { className: 'note' }, 'Nothing major shipped this day.'),
    ...KINDS.map((k) => {
      const hit = list.filter((x) => x.kind === k.key)
      if (!hit.length) return null
      const head = h('h3', null, jsx('span', { className: 'dot', style: { '--k': k.color } }), k.label, h('span', null, `${hit.length}`))
      if (k.key === 'catalog') {
        const shown = all ? hit : hit.slice(0, CATALOG_FOLD)
        return h('div', { className: 'sec', style: { '--k': k.color }, key: k.key }, head,
          h('div', { className: 'chips' },
            ...shown.map((x) => jsx('button', { type: 'button', className: 'chip', title: x.detail || x.title, onClick: () => openLink(urlOf(x)), children: x.title }, x.id)),
            hit.length > CATALOG_FOLD && !all ? jsx('button', { type: 'button', className: 'chip', onClick: () => setAll(true), children: `Show all ${hit.length}` }, 'more') : null))
      }
      return h('div', { className: 'sec', style: { '--k': k.color }, key: k.key }, head,
        ...hit.map((x) => jsx('div', { className: 'item', role: 'link', tabIndex: 0, title: urlOf(x),
          onClick: () => openLink(urlOf(x)), onKeyDown: (e) => { if (e.key === 'Enter') openLink(urlOf(x)) },
          children: [jsx('b', { children: x.title }, 't'), x.detail ? jsx('small', { children: x.detail }, 'd') : null, jsx('em', { children: fmtTime(x.at) }, 'e')] }, x.id)))
    }))
}

function CalendarPage() {
  const s = useStore()
  const [hidden, setHidden] = useState(() => new Set(lsGet('hermes-nous-calendar.hidden.v1', [])))
  const [pick, setPick] = useState(null)
  const month = s.view
  const d = s.months[month]
  useEffect(() => { if (!s.months[month] && !s.inflight[month]) load(month) }, [month])
  useEffect(() => { markOpened() }, [])
  const toggle = (k) => { const n = new Set(hidden); n.has(k) ? n.delete(k) : n.add(k); setHidden(n); lsSet('hermes-nous-calendar.hidden.v1', [...n]) }
  const go = (by) => { s.view = shiftMonth(month, by); setPick(null); emit() }
  const loading = Boolean(s.inflight[month])
  const days = byDay(d && d.drops, hidden)
  const today = (d && d.today) || new Date().toISOString().slice(0, 10)

  const [y, mo] = month.split('-').map(Number)
  const first = new Date(y, mo - 1, 1)
  const lead = (first.getDay() + 6) % 7          // Monday first
  const count = new Date(y, mo, 0).getDate()
  const isos = Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`)
  const cell = (iso) => jsx(DayCell, { iso, list: days[iso] || [], merged: d && d.merged ? d.merged[iso] : 0, today: iso === today, future: iso > today, selected: pick === iso, onPick: (v) => setPick(pick === v ? null : v) }, iso)

  const head = h('div', { className: 'head' },
    h('div', null, h('h1', null, 'Nous Calendar'), h('div', { className: 'sub' }, 'What Nous shipped for Hermes Agent, day by day')),
    h('div', { className: 'nav' },
      h('button', { type: 'button', onClick: () => go(-1), 'aria-label': 'Previous month' }, '‹'),
      h('b', null, fmtMonth(month)),
      h('button', { type: 'button', onClick: () => go(1), disabled: month >= thisMonth(), 'aria-label': 'Next month' }, '›'),
      month !== thisMonth() ? h('button', { type: 'button', onClick: () => { s.view = thisMonth(); setPick(null); emit() } }, 'Today') : null,
      h('button', { type: 'button', onClick: () => load(month, true), disabled: loading }, loading ? 'Reading…' : 'Check now')),
    d ? h('div', { className: 'stats' }, ...KINDS.map((k) => jsx('div', {
      className: `stat${hidden.has(k.key) ? ' off' : ''}`, style: { '--k': k.color }, role: 'button', tabIndex: 0,
      title: hidden.has(k.key) ? `Show ${k.label.toLowerCase()}` : `Hide ${k.label.toLowerCase()}`,
      onClick: () => toggle(k.key), onKeyDown: (e) => { if (e.key === 'Enter') toggle(k.key) },
      children: [jsx('span', { className: 'dot' }, 'd'), jsx('b', { children: (d.counts || {})[k.key] || 0 }, 'b'), k.label],
    }, k.key))) : null)

  const err = s.errors[month]
  const errs = d ? Object.entries(d.errors || {}) : []
  return h('div', { className: 'nc' },
    jsx('style', { children: CSS }),
    head,
    h('div', { className: 'scroll' },
      err && !d ? h('div', { className: 'err' }, `Could not read the calendar: ${err.slice(0, 300)}`,
        h('div', { className: 'note', style: { fontFamily: MONO } }, 'Fix: hermes plugins enable hermes-nous-calendar, then restart Hermes Desktop. GitHub limits: `gh auth login` on this machine.')) : null,
      !d && !err ? h('div', { className: 'note' }, loading ? 'Reading GitHub for this month… the first read of a month can take a minute.' : '') : null,
      d ? h('div', null,
        errs.length ? h('div', { className: 'warn' }, `Couldn't read: ${errs.map(([k, v]) => `${k} (${v})`).join(' · ')}`) : null,
        d.auth === 'anonymous' ? h('div', { className: 'warn' }, 'Not signed in to GitHub, so catalog additions come from commit messages and merged-PR counts are off. Run `gh auth login` for exact data.') : null,
        h('div', { className: 'wk' }, ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => jsx('div', { children: w }, w))),
        h('div', { className: 'grid' }, ...Array.from({ length: lead }, (_, i) => jsx('div', { className: 'cell blank' }, `b${i}`)), ...isos.map(cell)),
        h('div', { className: 'list' }, ...isos.filter((iso) => (days[iso] || []).length).reverse().map(cell)),
        pick ? jsx(DayPanel, { iso: pick, list: days[pick] || [], merged: d.merged ? d.merged[pick] : 0, onClose: () => setPick(null) }) : null,
        h('div', { className: 'legend' }, ...KINDS.map((k) => jsx('span', { children: [jsx('i', { className: 'dot', style: { '--k': k.color } }, 'i'), k.label] }, k.key)),
          jsx('span', { children: '◌ Merged PRs: every merged pull request that day, counted, not listed' }, 'm')),
        h('div', { className: 'note' }, `Read from public GitHub: NousResearch/hermes-agent (releases, plugin catalog, feat PRs) and NousResearch/hermes-official-plugins. Days in ${d.tz}. ${d.cached ? 'From cache' : 'Read'} at ${new Date((d.generated || 0) * 1000).toLocaleTimeString()}.`)) : null))
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
    style: { background: 'transparent', border: 0, cursor: 'pointer', padding: '0 6px', fontSize: 11, fontFamily: MONO, color: major ? '#e3b341' : fresh.length ? '#bc8cff' : 'var(--ui-text-tertiary,#a6a4b0)' },
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
    ctx.register({ id: 'open', area: PALETTE_AREA, data: { id: `${ID}.open`, label: 'Open Nous Calendar', keywords: ['nous', 'calendar', 'release', 'changelog', 'drops', 'what shipped', 'catalog'], run: () => host.navigate(ROUTE) } })
    ctx.register({ id: 'statusbar', area: STATUSBAR_AREAS.right, order: 132, render: () => jsx(StatusChip, {}) })
    startPolling(ctx)
  },
}
