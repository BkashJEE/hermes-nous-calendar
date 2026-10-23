// The web build's stand-in for @hermes/plugin-sdk: just enough for desktop/plugin.js to run as a
// public page. Data comes from the static month files the build wrote next to index.html.
export const ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar.nav', PALETTE_AREA = 'palette', STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const host = {
  navigate: () => {},
  notify: () => {},
  profileRoutes: async () => [],
  requestProfile: async () => { throw new Error('no Hermes here') },
}
export async function restCall(path) {
  const [route, query] = path.split('?')
  if (route !== '/month') throw new Error('404')
  const month = new URLSearchParams(query).get('month')
  const r = await fetch(`./data/${month}.json`, { cache: 'no-cache' })
  if (!r.ok) throw new Error(r.status === 404 ? `No data for ${month} yet` : `HTTP ${r.status}`)
  return r.json()
}
