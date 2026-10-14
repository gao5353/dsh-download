/**
 * UI route tests — the read-only endpoints the download panel reads.
 *
 * Two layers are checked here, because they fail differently. The first is the handler contract
 * against fake `req`/`res` objects: loopback gating, method gating, dispatch, and the promise that
 * a misbehaving dependency produces a response rather than an exception inside the host's request
 * dispatcher. The second runs the very same handler behind a real `node:http` server on a random
 * port and talks to it with `fetch`, which is the only way to prove headers, status codes and a
 * HEAD body actually behave over a socket.
 *
 * The suite is hermetic: `DSH_HOME` points at a throwaway directory before the plugin is imported,
 * so a run neither reads nor rewrites the user's real status and settings files.
 */

import { homedir } from 'node:os'
// Resolved from this file's own location, so a cloned copy runs anywhere.
const ROOT_LIB = new URL('../', import.meta.url).href

import { createServer } from 'node:http'
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(tmpdir(), `dsh-ui-routes-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
mkdirSync(ROOT, { recursive: true })

// The real status file must not be touched by a test run. Its size and modification time are
// captured first and compared at the end, because importing the plugin is enough to make it read
// that file and — were the home not redirected — rewrite it.
const REAL_STATUS = join(homedir(), '.dsh', 'dsh-download.status.json')
const realStatusBefore = existsSync(REAL_STATUS) ? statSync(REAL_STATUS) : null

// Point the plugin's home at the temporary directory BEFORE importing it: the host half reads
// DSH_HOME when it creates the status store, and this keeps that store out of the real one.
process.env.DSH_HOME = ROOT.replace(/\\/g, '/')

const BASE = `${ROOT_LIB}lib`
const routesModule = await import(`${BASE}/ui-routes.js`)
const { createStatusStore } = await import(`${BASE}/status.js`)
const plugin = await import(`${BASE}/index.js`)

const { createUiRoutes, settingsPayload, isLoopbackRequest, pathnameOf, UI_PREFIX, STATUS_PATH, SETTINGS_PATH } =
  routesModule

let failures = 0
const check = (label, condition, detail) => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition || detail !== undefined) console.log(`        ${detail}`)
}

/** A minimal stand-in for an IncomingMessage. */
function fakeRequest({ method = 'GET', url = STATUS_PATH, address = '127.0.0.1' } = {}) {
  return { method, url, socket: { remoteAddress: address } }
}

/** A minimal stand-in for a ServerResponse that records what was written. */
function fakeResponse() {
  const record = { status: null, headers: null, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(body) {
      if (typeof body === 'string') record.body = body
    },
  }
}

const settings = {
  path: `${ROOT}/dsh-download.settings.json`,
  problem: undefined,
  engine: 'builtin',
  monitor: 'block',
  thresholdBytes: 1073741824,
  builtinConnections: 16,
  uiPollIntervalMs: 1000,
  pollIntervalMs: 1500,
  stallTimeoutMs: 120000,
  taskAppearTimeoutMs: 45000,
  settleMs: 4000,
  downloadDir: undefined,
  ndmPath: undefined,
  taskRoot: undefined,
}

/** A dependency set that resolves every path, so the payload is fully populated. */
function makeDeps(overrides = {}) {
  return {
    status: createStatusStore({ path: `${ROOT}/status-${Math.floor(Math.random() * 1e6)}.json` }),
    loadSettings: () => settings,
    resolveNdmPath: () => 'D:\\Neat Download Manager\\NeatDM.exe',
    resolveDownloadDir: () => 'C:/Users/x/Downloads',
    resolveTaskRoot: () => 'C:/Users/x/AppData/Roaming/NeatDM',
    ...overrides,
  }
}

try {
  // ---- 1. the route table ----------------------------------------------------------------
  const deps = makeDeps()
  const routes = createUiRoutes(deps)
  check('exactly one route is contributed', routes.length === 1, `${routes.length}`)
  check('it is a prefix route', routes[0].kind === 'prefix', routes[0].kind)
  check('its path is this plugin\'s own prefix', routes[0].path === UI_PREFIX, routes[0].path)
  check(
    'its path cannot collide with the /plugins owner',
    routes[0].path !== '/plugins' && !routes[0].path.startsWith('/plugins/'),
    routes[0].path,
  )
  check('the two endpoints live under that prefix', STATUS_PATH.startsWith(UI_PREFIX) && SETTINGS_PATH.startsWith(UI_PREFIX))

  // ---- 2. loopback gating ----------------------------------------------------------------
  check('127.0.0.1 is loopback', isLoopbackRequest(fakeRequest({ address: '127.0.0.1' })))
  check('127.0.0.53 is loopback (the whole 127/8 is local)', isLoopbackRequest(fakeRequest({ address: '127.0.0.53' })))
  check('::1 is loopback', isLoopbackRequest(fakeRequest({ address: '::1' })))
  check(
    'a mapped IPv4 loopback is loopback',
    isLoopbackRequest(fakeRequest({ address: '::ffff:127.0.0.1' })),
  )
  check('a LAN address is not loopback', !isLoopbackRequest(fakeRequest({ address: '192.168.1.44' })))
  check('a public address is not loopback', !isLoopbackRequest(fakeRequest({ address: '203.0.113.9' })))
  check('a non-TCP transport counts as local', isLoopbackRequest({ socket: {} }))

  // ---- 3. path parsing -------------------------------------------------------------------
  check('a query string is stripped', pathnameOf(`${STATUS_PATH}?v=17`) === STATUS_PATH, pathnameOf(`${STATUS_PATH}?v=17`))
  check('a fragment is stripped', pathnameOf(`${STATUS_PATH}#top`) === STATUS_PATH)
  check('a malformed escape does not throw', pathnameOf('/dsh-download/%E0%A4%A') === '/dsh-download/%E0%A4%A')
  check('an empty url reads as root', pathnameOf('') === '/')

  // ---- 4. the status endpoint ------------------------------------------------------------
  const live = deps.status.begin({
    url: 'https://example.test/big.iso',
    dest: 'C:/out/big.iso',
    engine: 'built-in',
    total: 2000,
    connections: 8,
  })
  deps.status.progress(live.id, { bytes: 500 })

  const statusResponse = fakeResponse()
  await routes[0].handler(fakeRequest(), statusResponse)
  check('status answers 200', statusResponse.record.status === 200, String(statusResponse.record.status))
  check(
    'status is JSON, uncached and not sniffed',
    statusResponse.record.headers['content-type'].startsWith('application/json') &&
      statusResponse.record.headers['cache-control'] === 'no-store' &&
      statusResponse.record.headers['x-content-type-options'] === 'nosniff',
    JSON.stringify(statusResponse.record.headers),
  )
  const statusDocument = JSON.parse(statusResponse.record.body)
  check('the in-flight download is reported as active', statusDocument.active.length === 1, `${statusDocument.active.length}`)
  check('its byte count is current', statusDocument.active[0].bytes === 500, String(statusDocument.active[0].bytes))
  check('its percentage is derived', statusDocument.active[0].percent === 25, String(statusDocument.active[0].percent))
  check('its connection count is reported', statusDocument.active[0].connections === 8, String(statusDocument.active[0].connections))
  check(
    'content-length matches the body',
    Number(statusResponse.record.headers['content-length']) === Buffer.byteLength(statusResponse.record.body),
  )

  deps.status.finish(live.id, { ok: false, error: 'HTTP 403 from the mirror', hint: ' try another mirror' })
  const afterFinish = fakeResponse()
  await routes[0].handler(fakeRequest(), afterFinish)
  const finishedDocument = JSON.parse(afterFinish.record.body)
  check('a finished download leaves active', finishedDocument.active.length === 0)
  check(
    'the failure reason reaches the panel',
    finishedDocument.recent[0].error === 'HTTP 403 from the mirror' && finishedDocument.recent[0].hint === ' try another mirror',
    finishedDocument.recent[0].error,
  )

  // ---- 5. the settings endpoint ----------------------------------------------------------
  const settingsResponse = fakeResponse()
  await routes[0].handler(fakeRequest({ url: SETTINGS_PATH }), settingsResponse)
  const settingsDocument = JSON.parse(settingsResponse.record.body)
  check('settings answers 200', settingsResponse.record.status === 200)
  const expectedKeys = [
    'builtinConnections',
    'downloadDir',
    'engine',
    'monitor',
    'ndmPath',
    'pollIntervalMs',
    'problem',
    'settingsPath',
    'settleMs',
    'stallTimeoutMs',
    'taskAppearTimeoutMs',
    'taskRoot',
    'thresholdBytes',
    'uiPollIntervalMs',
    'version',
  ].sort()
  const actualKeys = Object.keys(settingsDocument).sort()
  check(
    'settings exposes exactly the whitelisted keys',
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    actualKeys.join(', '),
  )
  check(
    'the settings file help blocks never cross the wire',
    !('_readme' in settingsDocument) && !('_options' in settingsDocument),
  )
  check('resolved paths are served, not raw overrides', settingsDocument.downloadDir === 'C:/Users/x/Downloads')
  check('the downloader path is resolved', settingsDocument.ndmPath === 'D:\\Neat Download Manager\\NeatDM.exe')
  check('the panel refresh interval is carried through', settingsDocument.uiPollIntervalMs === 1000)

  // ---- 6. methods, unknown paths, index --------------------------------------------------
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = fakeResponse()
    await routes[0].handler(fakeRequest({ method }), response)
    check(`${method} is refused`, response.record.status === 405, String(response.record.status))
  }
  const headResponse = fakeResponse()
  await routes[0].handler(fakeRequest({ method: 'HEAD' }), headResponse)
  check('HEAD answers 200 with headers', headResponse.record.status === 200 && headResponse.record.headers['content-length'] !== undefined)
  check('HEAD sends no body', headResponse.record.body === '', JSON.stringify(headResponse.record.body.slice(0, 40)))

  const offsite = fakeResponse()
  await routes[0].handler(fakeRequest({ address: '192.168.1.44' }), offsite)
  check('a non-loopback peer is refused', offsite.record.status === 403, String(offsite.record.status))
  check('and it learns nothing about the payload', !offsite.record.body.includes('active'))

  const unknown = fakeResponse()
  await routes[0].handler(fakeRequest({ url: `${UI_PREFIX}/secrets.json` }), unknown)
  check('an unknown path is 404', unknown.record.status === 404, String(unknown.record.status))
  check(
    'the 404 lists the endpoints that do exist',
    Array.isArray(JSON.parse(unknown.record.body).endpoints),
    unknown.record.body.trim(),
  )

  const index = fakeResponse()
  await routes[0].handler(fakeRequest({ url: UI_PREFIX }), index)
  check('the bare prefix answers 200', index.record.status === 200, String(index.record.status))
  // The panel gained a settings write endpoint after this suite was written (another session added
  // POST <prefix>/settings with its own guards, covered by test-ui-write.mjs). What this suite owns
  // is the read side, so it asserts what the index must keep advertising: both read endpoints, and
  // that writes live on their own path rather than on either of them.
  const indexBody = JSON.parse(index.record.body)
  check(
    'the index advertises both read endpoints and the write path',
    Array.isArray(indexBody.endpoints) && indexBody.endpoints.length === 2 && typeof indexBody.write === 'string',
    JSON.stringify(indexBody),
  )
  check(
    'neither read endpoint is the write path',
    indexBody.write !== STATUS_PATH && indexBody.write !== SETTINGS_PATH,
    String(indexBody.write),
  )

  // ---- 7. a broken dependency must not throw into the host -------------------------------
  const throwingStore = createUiRoutes(makeDeps({ status: { snapshot() { throw new Error('store exploded') } } }))
  const broken = fakeResponse()
  let threw = false
  try {
    await throwingStore[0].handler(fakeRequest(), broken)
  } catch {
    threw = true
  }
  check('a throwing status store does not throw out of the handler', !threw)
  check('it becomes a 500 the panel can show', broken.record.status === 500, String(broken.record.status))
  check('and the reason is passed on', JSON.parse(broken.record.body).error === 'store exploded', broken.record.body.trim())

  const deadPeer = createUiRoutes(makeDeps())
  let deadPeerThrew = false
  try {
    await deadPeer[0].handler(fakeRequest(), {
      writeHead() {
        throw new Error('socket already closed')
      },
      end() {
        throw new Error('socket already closed')
      },
    })
  } catch {
    deadPeerThrew = true
  }
  check('a dead peer does not throw either', !deadPeerThrew)

  const badPath = fakeResponse()
  await deadPeer[0].handler(fakeRequest({ url: `${SETTINGS_PATH}?x=%` }), badPath)
  check('a malformed query does not break routing', badPath.record.status === 200, String(badPath.record.status))

  // ---- 8. degrading pieces of the settings document --------------------------------------
  const thrownLookup = settingsPayload({
    loadSettings: () => settings,
    resolveNdmPath() {
      throw new Error('where.exe is unavailable')
    },
  })
  check('a failing downloader lookup reads as "not detected"', thrownLookup.ndmPath === null, String(thrownLookup.ndmPath))

  const problemPayload = settingsPayload({
    loadSettings: () => ({ ...settings, problem: 'settings file is not valid JSON' }),
  })
  check('a settings problem is passed to the panel rather than thrown', typeof problemPayload.problem === 'string')

  const barePayload = settingsPayload({ loadSettings: () => settings })
  check('missing resolvers degrade to null instead of failing', barePayload.downloadDir === null && barePayload.taskRoot === null)

  // ---- 9. the same handler over a real socket --------------------------------------------
  const route = createUiRoutes(deps)[0]
  const server = createServer((req, res) => {
    // Mirror the webserver's own dispatch rule: prefix match, longest prefix wins.
    const pathname = pathnameOf(req.url)
    if (pathname === UI_PREFIX || pathname.startsWith(`${UI_PREFIX}/`)) {
      route.handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('fallback')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`

  try {
    const liveStatus = await fetch(`${origin}${STATUS_PATH}`)
    check('over HTTP the status endpoint answers 200', liveStatus.status === 200, String(liveStatus.status))
    check('over HTTP it is JSON', liveStatus.headers.get('content-type').startsWith('application/json'))
    check('over HTTP it is uncached', liveStatus.headers.get('cache-control') === 'no-store')
    const liveDocument = await liveStatus.json()
    check('over HTTP the finished download is visible', Array.isArray(liveDocument.recent), `${liveDocument.recent?.length}`)

    const liveSettings = await fetch(`${origin}${SETTINGS_PATH}?ts=1`)
    check('over HTTP the settings endpoint answers 200 with a query string', liveSettings.status === 200, String(liveSettings.status))
    check('over HTTP the engine setting is present', (await liveSettings.json()).engine === 'builtin')

    const liveHead = await fetch(`${origin}${STATUS_PATH}`, { method: 'HEAD' })
    check('over HTTP HEAD answers 200', liveHead.status === 200, String(liveHead.status))
    check('over HTTP HEAD carries a length', Number(liveHead.headers.get('content-length')) > 0)
    check('over HTTP HEAD carries no body', (await liveHead.text()) === '')

    const livePost = await fetch(`${origin}${STATUS_PATH}`, { method: 'POST', body: 'x=1' })
    check('over HTTP POST is refused', livePost.status === 405, String(livePost.status))

    const liveUnknown = await fetch(`${origin}${UI_PREFIX}/nope`)
    check('over HTTP an unknown endpoint is 404, not the SPA fallback', liveUnknown.status === 404, String(liveUnknown.status))

    const outside = await fetch(`${origin}/plugins/dsh-download/client.js`)
    check('over HTTP a path outside the prefix is left to the fallback', outside.status === 404, String(outside.status))
  } finally {
    // `fetch` keeps its sockets alive, so closing the listener alone leaves handles mid-teardown
    // and Node can abort on exit (a libuv assertion in async.c). Drop the connections explicitly.
    server.closeAllConnections?.()
    await new Promise((done) => server.close(done))
  }

  // ---- 10. apply() wires the routes in, and stays quiet when it cannot -------------------
  const registered = []
  const fakeHost = {
    register(registeredRoute) {
      registered.push(registeredRoute)
      return () => {}
    },
  }
  plugin.apply({
    tools: { register() {} },
    get() {
      return undefined
    },
    effect(fn) {
      return fn()
    },
    inject(deps2, callback) {
      check('the ui registration asks for the optional webserver service', deps2.includes('webServer'), deps2.join(', '))
      callback({ get: (service) => (service === 'webServer' ? fakeHost : undefined) })
      return { then() {} }
    },
  })
  check('apply registers the panel route on the host webserver', registered.length === 1, `${registered.length}`)
  check('through the same prefix', registered[0]?.path === UI_PREFIX, String(registered[0]?.path))
  check('and it is dispatchable', typeof registered[0]?.handler === 'function')

  // A host with no webserver at all must be survivable: the tool is the point, the panel is not.
  let noWebServerThrew = false
  try {
    plugin.apply({
      tools: { register() {} },
      get() {
        return undefined
      },
      effect(fn) {
        return fn()
      },
      inject(deps2, callback) {
        callback({ get: () => undefined })
        return { then() {} }
      },
    })
  } catch {
    noWebServerThrew = true
  }
  check('a host without a webserver does not throw', !noWebServerThrew)

  // Contexts without a scoped inject (older hosts, and the test stubs used elsewhere) take the
  // direct lookup path; a getter that returns a non-registerable object must be ignored.
  let legacyThrew = false
  try {
    plugin.apply({
      tools: { register() {} },
      get() {
        return { section() {} }
      },
      effect(fn) {
        return fn()
      },
    })
  } catch {
    legacyThrew = true
  }
  check('a context without inject falls back without throwing', !legacyThrew)

  // The plugin must not have created or rewritten anything in the real dsh home: DSH_HOME was
  // redirected above, and this is the assertion that proves the redirect worked.
  const realStatusAfter = existsSync(REAL_STATUS) ? statSync(REAL_STATUS) : null
  check(
    'the real status file was left untouched',
    realStatusBefore === null
      ? realStatusAfter === null
      : realStatusAfter !== null &&
          realStatusAfter.size === realStatusBefore.size &&
          realStatusAfter.mtimeMs === realStatusBefore.mtimeMs,
    realStatusBefore === null ? 'absent before and after' : `${realStatusBefore.size} bytes, mtime ${realStatusBefore.mtimeMs}`,
  )
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
// `process.exitCode`, not `process.exit()`: this suite talks to a real socket with `fetch`, and on
// Node 25 an explicit exit while the HTTP client is still releasing its handles aborts the process
// inside libuv (an assertion in async.c) — which would report a crash in place of the real result.
process.exitCode = failures === 0 ? 0 : 1
