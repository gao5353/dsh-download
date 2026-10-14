/**
 * HTTP endpoints for the download panel — the host half of the UI.
 *
 * Why HTTP and not a Remote service
 * ---------------------------------
 * The shipped way for a client plugin to reach the host is a Typert remote service. That needs
 * a decorator, therefore a build step, and it pins the plugin to one
 * `@deepseek-ai/dsh-typert-protocol` version. This plugin is hand-written and carries zero npm
 * dependencies on purpose — that is what lets the same folder work on any machine and any dsh
 * version — so the panel talks plain JSON over routes registered on the host's `webServer`
 * service instead. The browser half stays a file with no build step.
 *
 * Why there IS a write endpoint
 * -----------------------------
 * An earlier revision was read-only, on the reasoning that settings live in a file the user owns
 * and a write path would widen the attack surface. That reasoning had the usability backwards:
 * a panel that only *shows* settings is not a settings UI. Someone who does not know what a file
 * path is will never open `dsh-download.settings.json`, so "edit the file" is not an answer to
 * "how do I change the threshold" — it is the absence of one. Typing a number into a box is the
 * feature; the file is only where the number is kept.
 *
 * So POST is served, under three guards that together keep it as narrow as the read path:
 *   - **loopback peer only**, exactly as for reads;
 *   - **same-origin only**, because any page in the user's browser can reach loopback, and a
 *     cross-origin POST always carries `Origin` — so requiring it to match the request's host is
 *     what stops an unrelated page from repointing the downloader at another directory;
 *   - **allow-list validation on the host**, so an unknown key or a nonsensical value is rejected
 *     at the boundary instead of landing in the file and breaking every later download.
 *
 * Loopback only
 * -------------
 * The payload carries absolute local paths. A webserver configured to bind `0.0.0.0` — a LAN or
 * tunnel setup — would otherwise publish someone's filesystem layout to the network, so a
 * request whose peer is not loopback is answered 403.
 *
 * Never throws into the server
 * ----------------------------
 * Every path is wrapped: a status store that misbehaves, or a peer that vanished mid-write,
 * must produce a response or nothing at all, never an exception inside the host's request
 * dispatcher.
 *
 * @module dsh-download/ui-routes
 */

/**
 * Route prefix owned by this plugin.
 *
 * `dsh-client-modules` already claims `prefix: /plugins`, and a duplicate `(kind, path)` throws,
 * so this has to be a prefix of its own.
 */
export const UI_PREFIX = '/dsh-download'

/** Live status: what is downloading now, and how the recent ones ended. */
export const STATUS_PATH = `${UI_PREFIX}/status.json`

/** The effective settings, reduced to the keys the panel shows. */
export const SETTINGS_PATH = `${UI_PREFIX}/settings.json`

/** Where the panel POSTs a settings change. */
export const SETTINGS_WRITE_PATH = `${UI_PREFIX}/settings`

/** Largest accepted write body. A settings patch is a handful of scalars. */
const MAX_BODY_BYTES = 16 * 1024

/** Peer addresses that mean "this machine". */
const LOOPBACK_ADDRESSES = new Set(['::1', '::ffff:127.0.0.1'])

/**
 * Whether a request came from this machine.
 *
 * A loopback peer is either `::1` or anywhere in `127.0.0.0/8` — the address the browser
 * actually uses may be `127.0.0.1`, `::ffff:127.0.0.1`, or another `127.x` on multi-homed
 * setups. A missing address means the transport is not TCP at all (a pipe or in-process call),
 * which is local by definition.
 *
 * @param req - the incoming request.
 * @returns true when the peer is local.
 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  if (address === undefined || address === null || address === '') return true
  return LOOPBACK_ADDRESSES.has(address) || address.startsWith('127.')
}

/**
 * The pathname of a request URL, without query or fragment.
 * @param url - `req.url`, e.g. `/dsh-download/status.json?cache=0`.
 * @returns the decoded pathname, or `/` when nothing usable is there.
 */
export function pathnameOf(url) {
  if (typeof url !== 'string' || url === '') return '/'
  const bare = url.split('?')[0].split('#')[0]
  try {
    return decodeURIComponent(bare)
  } catch {
    // A malformed percent-escape is not worth a 500; compare it verbatim.
    return bare
  }
}

/**
 * Whether a write request came from the dsh web UI itself.
 *
 * A loopback peer proves the request came from this machine, not that it came from this
 * application: every page the user has open can reach loopback. Browsers attach `Origin` to any
 * cross-origin POST and set `Sec-Fetch-Site`, so requiring the origin's host to equal the
 * request's own `Host` header is what separates the panel from some other tab.
 *
 * @param req - the incoming request.
 * @returns true when the request is same-origin, or when the transport proves it local.
 */
export function isSameOriginRequest(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (site === 'same-origin') return true
  if (site === 'cross-site' || site === 'same-site') return false

  const origin = req?.headers?.origin
  // A cross-origin POST always carries Origin, so its absence is not evidence of trust.
  if (origin === undefined || origin === null || origin === '') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Read and parse a JSON request body, with a hard size cap.
 *
 * The cap is not about a hostile remote peer — the peer is already known to be loopback — but
 * about not letting a runaway client stream the host process out of memory.
 *
 * @param req - the incoming request.
 * @returns the parsed value, or a reason it was refused.
 */
function readJsonBody(req) {
  return new Promise((done) => {
    const chunks = []
    let size = 0
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      done(result)
    }

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: `body larger than ${MAX_BODY_BYTES} bytes` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        finish({ ok: false, error: 'the body must be a JSON object of settings' })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(text) })
      } catch (error) {
        finish({ ok: false, error: `the body is not valid JSON: ${error instanceof Error ? error.message : String(error)}` })
      }
    })
    req.on('error', (error) => finish({ ok: false, error: `reading the body failed: ${error.message}` }))
  })
}

/**
 * Write a JSON response.
 *
 * `cache-control: no-store` matters here: the panel polls, and a cached progress document would
 * show a download frozen at whatever moment the browser last stored it.
 *
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param payload - any JSON-serializable value.
 * @param method - the request method, so HEAD sends headers only.
 */
function send(res, status, payload, method) {
  let body
  try {
    body = `${JSON.stringify(payload)}\n`
  } catch {
    // A payload that cannot be serialized (a circular structure from a future field) must still
    // produce a truthful answer rather than an exception.
    body = `${JSON.stringify({ error: 'response payload was not serializable' })}\n`
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(method === 'HEAD' ? undefined : body)
  } catch {
    /* the peer is already gone; there is nobody left to tell */
  }
}

/**
 * Build the settings document the panel renders.
 *
 * Only whitelisted keys cross the wire. The settings file is a user-editable document that may
 * carry anything — including the long `_readme` and `_options` help blocks — and echoing it back
 * wholesale would ship kilobytes the panel never shows. Values here are the *effective* ones:
 * after the file, the environment and the built-in defaults have been resolved, so what the
 * panel displays is what a download would actually do.
 *
 * @param deps - settings loader plus the resolvers that turn overrides into real paths.
 * @returns the document served at {@link SETTINGS_PATH}.
 */
export function settingsPayload(deps) {
  const settings = deps.loadSettings()

  // Resolving the downloader path consults the filesystem and, as a last resort, PATH. It can
  // fail on an odd machine, and a failed lookup must read as "not detected", not as an error.
  let ndmPath = null
  try {
    ndmPath = deps.resolveNdmPath?.(settings.ndmPath) ?? null
  } catch {
    ndmPath = null
  }

  return {
    version: 1,
    engine: settings.engine,
    monitor: settings.monitor,
    thresholdBytes: settings.thresholdBytes,
    builtinConnections: settings.builtinConnections,
    uiPollIntervalMs: settings.uiPollIntervalMs,
    pollIntervalMs: settings.pollIntervalMs,
    stallTimeoutMs: settings.stallTimeoutMs,
    taskAppearTimeoutMs: settings.taskAppearTimeoutMs,
    settleMs: settings.settleMs,
    downloadDir: deps.resolveDownloadDir?.(settings.downloadDir) ?? null,
    taskRoot: deps.resolveTaskRoot?.(settings.taskRoot) ?? null,
    ndmPath,
    settingsPath: settings.path,
    problem: settings.problem ?? null,
  }
}

/**
 * Build the route table this plugin contributes to the host webserver.
 *
 * One prefix route rather than two exact ones: the prefix is a single entry in a table where a
 * collision throws at load time, so fewer registrations means fewer ways to break someone
 * else's plugin. Dispatch on the pathname happens here instead.
 *
 * @param deps - the status store, settings loader and path resolvers.
 * @returns route registrations for `webServer.register()`.
 */
export function createUiRoutes(deps) {
  const handler = async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (!isLoopbackRequest(req)) {
        send(res, 403, { error: 'this endpoint only answers requests from this machine' }, method)
        return
      }

      const pathname = pathnameOf(req.url)

      // ---------------------------------------------------------------- settings write
      if (pathname === SETTINGS_WRITE_PATH) {
        if (method !== 'POST') {
          send(res, 405, { error: 'this endpoint accepts POST', allow: 'POST' }, method)
          return
        }
        if (!isSameOriginRequest(req)) {
          send(
            res,
            403,
            { error: 'settings can only be changed from the dsh web UI itself' },
            method,
          )
          return
        }
        if (typeof deps.writeSettingsPatch !== 'function') {
          send(res, 501, { error: 'this build cannot write settings' }, method)
          return
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          send(res, 400, { ok: false, error: body.error }, method)
          return
        }
        const result = deps.writeSettingsPatch(body.value)
        // 400 rather than 500 for a rejected patch: the caller sent something invalid, and the
        // response says which keys and why.
        send(res, result.ok === true ? 200 : 400, result, method)
        return
      }

      // ------------------------------------------------------------------ read paths
      if (method !== 'GET' && method !== 'HEAD') {
        send(
          res,
          405,
          { error: `only GET and HEAD are served at ${pathname}`, writeEndpoint: SETTINGS_WRITE_PATH },
          method,
        )
        return
      }

      if (pathname === STATUS_PATH) {
        // Straight from memory, not from the mirror file: the running registry is strictly
        // fresher, and it cannot show a previous process's abandoned `active` entry as live.
        send(res, 200, deps.status.snapshot(), method)
        return
      }
      if (pathname === SETTINGS_PATH) {
        send(res, 200, settingsPayload(deps), method)
        return
      }
      if (pathname === UI_PREFIX || pathname === `${UI_PREFIX}/`) {
        send(
          res,
          200,
          {
            plugin: 'dsh-download',
            endpoints: [STATUS_PATH, SETTINGS_PATH],
            write: SETTINGS_WRITE_PATH,
          },
          method,
        )
        return
      }
      send(res, 404, { error: `no endpoint at ${pathname}`, endpoints: [STATUS_PATH, SETTINGS_PATH] }, method)
    } catch (error) {
      // The host's dispatcher called us; throwing back into it would be a bug in this plugin
      // surfacing as a failure in an unrelated request path.
      send(res, 500, { error: error instanceof Error ? error.message : String(error) }, method)
    }
  }

  return [{ kind: 'prefix', path: UI_PREFIX, handler }]
}
