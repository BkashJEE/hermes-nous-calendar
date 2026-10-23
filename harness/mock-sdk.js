// Test harness only: mimics the parts of @hermes/plugin-sdk that hermes-nous-calendar uses.
// Serves harness/demo.json for its own month; other months come back empty.
// ?via=cli makes ctx.rest fail like a profile where the backend isn't mounted, so the CLI path runs.
// ?today=2026-10-22 pins "today" for screenshots.
const params = new URLSearchParams(location.search)
const demo = await fetch(params.get('demo') === 'public' ? './demo-public.json' : './demo.json', { cache: 'no-store' }).then((r) => r.json())
if (params.get('today')) demo.today = params.get('today')
const empty = (month) => ({ ...demo, month, drops: [], merged: {}, counts: Object.fromEntries(Object.keys(demo.counts).map((k) => [k, 0])) })
const answer = (month) => (month === demo.month ? demo : empty(month))

export async function restCall(path) {
  window.__rest = (window.__rest || []).concat([path])
  if (params.get('via') === 'cli') throw new Error('404: {"detail":"Not Found"}')
  const [route, query] = path.split('?')
  if (route === '/month') return answer(new URLSearchParams(query).get('month'))
  throw new Error('404: no route ' + route)
}
export const ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar.nav', PALETTE_AREA = 'palette', STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const host = {
  navigate: (p) => { window.__nav = p },
  notify: (n) => console.log('notify', n),
  profileRoutes: async () => [{ connectionId: 'local', mode: 'local', primary: true, profile: 'ceo', targetProfile: 'ceo' }],
  requestProfile: async (route, method, p) => {
    window.__calls = (window.__calls || []).concat([{ method, argv: p.argv }])
    const month = p.argv[p.argv.indexOf('--month') + 1]
    const d = answer(month)
    const slim = { ...d, drops: d.drops.map((x) => (x.kind === 'catalog' ? { id: x.id, kind: x.kind, day: x.day, at: x.at, title: x.title, label: x.label, major: x.major } : x)) }
    return { code: 0, output: 'a log line\n' + JSON.stringify(slim) }
  },
}

// Stand-in for the SDK's chat renderer: a markdown link whose click would open Desktop's in-app browser.
import { jsx as _jsx } from 'react/jsx-runtime'
export function MessageTextContent({ text }) {
  const m = /^\[(.*)\]\((.*)\)$/.exec(text || '')
  if (!m) return _jsx('span', { children: text })
  return _jsx('a', { href: m[2], onClick: (e) => { e.preventDefault(); window.__inapp = (window.__inapp || []).concat([m[2]]) }, children: m[1] })
}
