/**
 * dsh-download — a DSH bundle that adds one model-facing tool, `download_file`.
 *
 * Why it exists
 * -------------
 * Downloading a multi-gigabyte file inside a tool call is expensive in tokens only
 * because of how progress is observed. Reading a downloader's progress output puts
 * tens of kilobytes of progress-bar text into the model context, and polling it
 * repeatedly multiplies that. This plugin removes the problem structurally:
 *
 *   - the tool declares NO `timeoutMs`, so the harness imposes no tool-call deadline,
 *     and the download is awaited inside a single `execute()` call. Waiting inside a
 *     tool call is free: only the returned value enters the model context.
 *   - the return value is ONE short string ("OK 5.54 GiB -> <path> (task 199, 4m12s)").
 *   - failures come back as "FAIL <reason>" in the same single string, so an error is
 *     reported immediately instead of being discovered by polling.
 *
 * Routing
 * -------
 *   size >= thresholdBytes (default 1 GiB)  -> Neat Download Manager (multi-connection)
 *   size <  thresholdBytes                  -> direct download in-process
 *
 * Neat Download Manager is driven headlessly: `NeatDM.exe <url>` hands the URL to the
 * running instance, which writes a new task directory `%APPDATA%\NeatDM\<id>\`. This
 * plugin watches that directory's `LogFile.txt` for a terminal engine state and then
 * verifies the finished file on disk.
 *
 * Zero runtime dependencies: Node builtins only, so the same folder works on any
 * machine and any dsh version. Settings are read from the environment, not from a
 * validated config schema, for the same reason.
 *
 * The download panel
 * ------------------
 * The same status registry that costs nothing feeds a panel under Settings → Plugins, through
 * two read-only GET routes this plugin registers on the host's `webServer`
 * (`/dsh-download/status.json`, `/dsh-download/settings.json`). That service is optional and
 * requested through a scoped `inject`: a host without a webserver still gets the tool, and the
 * panel attaches itself whenever the webserver does appear. Nothing there can write, and nothing
 * there is polled unless that tab is actually on screen.
 *
 * Environment overrides
 * ---------------------
 *   DSH_NDM_PATH        full path to NeatDM.exe
 *   DSH_NDM_DIR         directory Neat Download Manager saves finished files into
 *   DSH_NDM_THRESHOLD   routing threshold in bytes (default 1073741824)
 *   DSH_NDM_TASKROOT    Neat Download Manager task directory (default %APPDATA%\NeatDM)
 *   DSH_NDM_STATUS      where the download-status mirror is written (default $DSH_HOME)
 *   DSH_NDM_UI_POLL_MS  download panel refresh interval in ms
 *
 * @module dsh-download
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { downloadSegmented } from './engine-builtin.js'
import { createStatusStore, statusFilePath } from './status.js'
import { createUiRoutes } from './ui-routes.js'

/** Cordis plugin name. */
export const name = 'tool-dsh-download'

/** Hard dependency: the host tool registry this plugin contributes to. */
export const inject = ['tools']

/** Default routing threshold: 1 GiB. */
const DEFAULT_THRESHOLD = 1024 * 1024 * 1024

/** How long to wait for Neat Download Manager to create a task directory. */
const TASK_APPEAR_TIMEOUT_MS = 45000

/** Poll interval while watching a running Neat Download Manager task. */
const POLL_INTERVAL_MS = 1500

/** How long a finished-looking file must stop growing before it counts as complete. */
const SETTLE_MS = 4000

/**
 * Last-resort stall window. Neat Download Manager normally names its terminal state
 * within a second or two, including failures, so this only catches a true hang.
 */
const STALL_TIMEOUT_MS = 120000

/** Default parallel connections for the built-in engine. */
const BUILTIN_CONNECTIONS = 16

/**
 * How often the download panel refreshes while it is on screen.
 *
 * One second is fast enough that a progress bar moves visibly without turning a status file into
 * a busy loop; the panel stops polling entirely the moment its tab is not displayed.
 */
const UI_POLL_INTERVAL_MS = 1000

/**
 * How long an interrupted download may keep its partial file and resume state, in days.
 *
 * Long enough that a deliberate interrupt can be continued the next day; short enough that a
 * forgotten partial does not sit in someone's download folder forever. Zero disables keeping
 * partials altogether, which trades resume away for a folder that never contains leftovers.
 */
const PARTIAL_RETENTION_DAYS = 7

/** Candidate install locations, checked in order when DSH_NDM_PATH is unset. */
const NDM_CANDIDATES = [
  'D:\\Neat Download Manager\\NeatDM.exe',
  'C:\\Program Files\\Neat Download Manager\\NeatDM.exe',
  'C:\\Program Files (x86)\\Neat Download Manager\\NeatDM.exe',
  'C:\\Neat Download Manager\\NeatDM.exe',
]

/** Sleep helper. */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/**
 * Read an integer environment override, or undefined when it is unset or malformed.
 *
 * Returning `undefined` rather than a fallback is what lets the caller tell "the environment said
 * nothing" apart from "the environment said something", which is the whole basis of an override.
 */
function envNumber(key) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read a string environment override. */
function envString(key, fallback) {
  const raw = process.env[key]
  return raw === undefined || raw === '' ? fallback : raw
}

/**
 * A machine-local settings file, re-read on every call.
 *
 * Living outside the plugin folder is deliberate: the folder is copied between
 * machines, and a path that is correct here would be wrong there. It also means an edit
 * takes effect on the very next download instead of requiring a dsh restart.
 */
function settingsFilePath() {
  const home = envString('DSH_HOME', join(homedir(), '.dsh'))
  return join(home, 'dsh-download.settings.json')
}

/** The documented default document, written only when no settings file exists yet. */
function defaultSettingsDocument() {
  return {
    _readme:
      'Settings for dsh-download. Edited values apply on the next download; no restart needed. ' +
      'Delete any key to fall back to its default. Environment variables (DSH_NDM_*) are used when a key is absent.',
    _options: {
      engine:
        '"builtin" (default) uses the engine inside this plugin: nothing to install, chooses its own User-Agent so mirrors that refuse browser spoofing still serve it, and writes straight to the destination. "ndm" uses Neat Download Manager instead - more battle-tested, and it shows a progress window, but it needs the program installed and always downloads into its own folder before the file is moved.',
      thresholdBytes: 'Size at or above which a download goes through Neat Download Manager. 1 GiB = 1073741824. For the built-in engine it is the size at which full parallelism kicks in.',
      builtinConnections: 'Parallel connections used by the built-in engine.',
      monitor: '"block" waits for the transfer and reports the outcome. "none" hands it to Neat Download Manager and returns at once.',
      pollIntervalMs: 'How often the task log is checked while monitoring Neat Download Manager.',
      stallTimeoutMs: 'Give up on a monitored task after this long with no byte movement.',
      taskAppearTimeoutMs: 'How long to wait for Neat Download Manager to open a task for the URL.',
      settleMs: 'How long a finished file must stop growing before it counts as complete.',
      ndmPath: 'Full path to NeatDM.exe. Omit to auto-detect. Only used by the NDM engine.',
      downloadDir: "Directory Neat Download Manager saves into. Omit for the user's Downloads folder.",
      taskRoot: 'Neat Download Manager task directory. Omit for %APPDATA%\\NeatDM.',
      uiPollIntervalMs:
        'How often the download panel refreshes while it is open, in milliseconds. The panel only polls while its tab is visible, so this costs nothing when the tab is closed.',
      partialRetentionDays:
        'How long an interrupted download may leave its partial file and resume state on disk before they are swept away, in days. Set 0 to never keep a partial at all: a stopped transfer then removes everything immediately and cannot be resumed.',
    },
    engine: 'builtin',
    thresholdBytes: DEFAULT_THRESHOLD,
    builtinConnections: BUILTIN_CONNECTIONS,
    monitor: 'block',
    pollIntervalMs: POLL_INTERVAL_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    taskAppearTimeoutMs: TASK_APPEAR_TIMEOUT_MS,
    settleMs: SETTLE_MS,
    uiPollIntervalMs: UI_POLL_INTERVAL_MS,
    partialRetentionDays: PARTIAL_RETENTION_DAYS,
  }
}

/**
 * Resolve `partialRetentionDays`, where zero is a real choice rather than a missing value.
 *
 * The general `number` helper treats 0 as "unset" and falls through to the default, which would
 * make the documented "0 = never keep a partial" impossible to express. Here 0 is honoured.
 *
 * @param envValue - the raw environment override, if any.
 * @param fileValue - the raw value from the settings file, if any.
 * @returns days to keep a partial transfer, or 0 to keep none.
 */
function readPartialRetentionDays(envValue, fileValue) {
  if (typeof envValue === 'string' && /^\d+$/.test(envValue.trim())) return Number.parseInt(envValue.trim(), 10)
  const parsed = Number(fileValue)
  if (Number.isInteger(parsed) && parsed >= 0) return parsed
  return PARTIAL_RETENTION_DAYS
}

/**
 * Remove partial transfers nobody is going to resume.
 *
 * The status registry is the only source of paths used here — it holds the destinations this plugin
 * itself wrote to, so this can never wander into a folder it does not own. Only the three exact
 * names this engine produces are considered (`<dest>.part`, `<dest>.part.json`, and that state's
 * `.tmp` sibling), only for transfers that are finished rather than in flight, and only once the
 * files themselves are older than the retention window. A file that is not ours is never a
 * candidate, whatever it is called.
 *
 * @param status - the status registry.
 * @param retentionDays - keep partials younger than this; 0 sweeps every settled partial.
 * @returns the paths that were removed.
 */
function sweepStalePartials(status, retentionDays) {
  const removed = []
  try {
    const snapshot = status.snapshot()
    const busy = new Set(snapshot.active.map((entry) => entry.dest))
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    for (const entry of snapshot.recent) {
      const dest = entry.dest
      if (typeof dest !== 'string' || dest === '') continue
      if (busy.has(dest)) continue
      const staged = `${dest}.part`
      const state = `${dest}.part.json`
      const temporary = `${state}.tmp`
      const complete = existsSync(staged) && existsSync(state)
      // Half a pair is not a resumable transfer however new it is: a partial with no state cannot
      // be continued (nobody knows which bytes are valid), and a state with no partial describes
      // nothing. Those go immediately; a complete pair gets the retention window.
      for (const path of [staged, state, temporary]) {
        try {
          if (!existsSync(path)) continue
          if (complete && statSync(path).mtimeMs > cutoff) continue
          rmSync(path, { force: true })
          removed.push(path)
        } catch {
          /* a locked or vanished file is not worth reporting */
        }
      }
    }
  } catch {
    /* sweeping is housekeeping; it must never be able to break startup */
  }
  return removed
}

/**
 * Resolve the effective settings.
 *
 * Precedence is settings file, then environment variable, then built-in default, so an
 * existing environment-only setup keeps working untouched. A malformed file is reported
 * rather than thrown: a typo in a settings file must not break every download.
 *
 * @returns the resolved settings plus `problem`, set when the file could not be read.
 */
function loadSettings() {
  const path = settingsFilePath()
  let file = {}
  let problem

  if (existsSync(path)) {
    try {
      // Strip a UTF-8 BOM before parsing. Windows Notepad saves UTF-8 files WITH a BOM
      // by default, and so does PowerShell's `Set-Content -Encoding UTF8`, while
      // JSON.parse rejects a leading U+FEFF outright. Without this, opening the settings
      // file in Notepad and saving it — the most natural thing a non-technical user can
      // do — would silently disable every setting and fall back to defaults.
      const raw = readFileSync(path, 'utf8')
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        problem = `${path} must contain a JSON object; using defaults`
      } else {
        file = parsed
      }
    } catch (error) {
      problem = `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using defaults`
    }
  }

  // The environment wins over the file, which is the precedence the README always claimed. It has
  // to work this way round: the plugin writes a settings file containing every numeric key on its
  // first load, so with the file first, six documented `DSH_NDM_*` overrides were silently inert on
  // every machine that had ever run the plugin. Measured, not assumed — see probe-env-overrides.mjs.
  const number = (key, envKey, fallback) => {
    const fromEnv = envNumber(envKey)
    if (fromEnv !== undefined) return fromEnv
    const fromFile = Number(file[key])
    if (Number.isFinite(fromFile) && fromFile > 0) return Math.round(fromFile)
    return fallback
  }
  const text = (key, envKey) => {
    const fromEnv = envString(envKey, '')
    if (fromEnv !== '') return fromEnv
    if (typeof file[key] === 'string' && file[key].trim() !== '') return file[key].trim()
    return undefined
  }

  return {
    path,
    problem,
    thresholdBytes: number('thresholdBytes', 'DSH_NDM_THRESHOLD', DEFAULT_THRESHOLD),
    pollIntervalMs: number('pollIntervalMs', 'DSH_NDM_POLL_MS', POLL_INTERVAL_MS),
    stallTimeoutMs: number('stallTimeoutMs', 'DSH_NDM_STALL_MS', STALL_TIMEOUT_MS),
    taskAppearTimeoutMs: number('taskAppearTimeoutMs', 'DSH_NDM_APPEAR_MS', TASK_APPEAR_TIMEOUT_MS),
    settleMs: number('settleMs', 'DSH_NDM_SETTLE_MS', SETTLE_MS),
    uiPollIntervalMs: number('uiPollIntervalMs', 'DSH_NDM_UI_POLL_MS', UI_POLL_INTERVAL_MS),
    // Read separately from `number` above, because that helper rejects 0 and 0 is a meaningful
    // value here: it means "keep no partial at all".
    partialRetentionDays: readPartialRetentionDays(process.env.DSH_NDM_PARTIAL_DAYS, file.partialRetentionDays),
    builtinConnections: number('builtinConnections', 'DSH_BUILTIN_CONNECTIONS', BUILTIN_CONNECTIONS),
    // Anything other than an explicit "ndm" uses the built-in engine, which needs no
    // external program and reaches mirrors that refuse a browser-spoofing User-Agent.
    engine: file.engine === 'ndm' ? 'ndm' : 'builtin',
    // Anything other than an explicit "none" keeps the safe default of waiting.
    monitor: file.monitor === 'none' ? 'none' : 'block',
    ndmPath: text('ndmPath', 'DSH_NDM_PATH'),
    downloadDir: text('downloadDir', 'DSH_NDM_DIR'),
    taskRoot: text('taskRoot', 'DSH_NDM_TASKROOT'),
  }
}

/**
 * Create the settings file with documented defaults, when none exists.
 *
 * Never overwrites: an existing file is the user's, whatever it says.
 *
 * @returns the path when a file was created, otherwise undefined.
 */
function ensureSettingsFile() {
  const path = settingsFilePath()
  if (existsSync(path)) return undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(defaultSettingsDocument(), null, 2)}\n`, 'utf8')
    return path
  } catch {
    // A read-only home directory is not a reason to fail a download.
    return undefined
  }
}

/**
 * Read the raw settings document, unresolved.
 *
 * Distinct from {@link loadSettings}, which resolves defaults and environment fallbacks. A
 * settings UI must show what is actually stored, so that clearing a field is visibly different
 * from a value that merely looks like the default.
 *
 * @returns the stored keys, or an empty object when absent or unreadable.
 */
function readSettingsDocument() {
  const path = settingsFilePath()
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8')
    // A UTF-8 BOM is what Windows Notepad writes by default and JSON.parse rejects it.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Which settings a UI may write, and what counts as a valid value for each.
 *
 * An allow-list rather than a blind merge: the endpoint accepts input from a browser, so an
 * unknown key or a nonsensical value must be rejected here rather than land in the file and
 * break every later download. Paths accept an empty string, which removes the key and restores
 * auto-detection.
 */
const WRITABLE_SETTINGS = {
  engine: (value) => (value === 'builtin' || value === 'ndm' ? value : undefined),
  monitor: (value) => (value === 'block' || value === 'none' ? value : undefined),
  thresholdBytes: (value) => boundedInteger(value, 1, Number.MAX_SAFE_INTEGER),
  builtinConnections: (value) => boundedInteger(value, 1, 64),
  pollIntervalMs: (value) => boundedInteger(value, 100, 60000),
  // The panel's own refresh cadence. 0 means "do not poll", which is a legitimate choice for
  // someone who would rather refresh by hand during a long download.
  uiPollIntervalMs: (value) => boundedInteger(value, 0, 60000),
  stallTimeoutMs: (value) => boundedInteger(value, 5000, 3600000),
  taskAppearTimeoutMs: (value) => boundedInteger(value, 5000, 600000),
  settleMs: (value) => boundedInteger(value, 0, 60000),
  ndmPath: (value) => (typeof value === 'string' ? value.trim() : undefined),
  downloadDir: (value) => (typeof value === 'string' ? value.trim() : undefined),
  taskRoot: (value) => (typeof value === 'string' ? value.trim() : undefined),
}

/** Accept an integer inside a range, or nothing. */
function boundedInteger(value, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return undefined
  const rounded = Math.round(parsed)
  return rounded >= min && rounded <= max ? rounded : undefined
}

/**
 * Merge a patch into the stored settings and write the file.
 *
 * Written as UTF-8 without a BOM on purpose: PowerShell's `Set-Content -Encoding UTF8` and
 * Notepad both emit a BOM, and a BOM once made every setting silently fall back to defaults.
 *
 * @param patch - candidate keys and values from a UI.
 * @returns which keys were applied and which were rejected, and why.
 */
function writeSettingsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'the body must be a JSON object of settings' }
  }

  const document = readSettingsDocument()
  const applied = []
  const rejected = []

  for (const [key, raw] of Object.entries(patch)) {
    const validate = WRITABLE_SETTINGS[key]
    if (validate === undefined) {
      rejected.push({ key, reason: 'unknown setting' })
      continue
    }
    const value = validate(raw)
    if (value === undefined) {
      rejected.push({ key, reason: 'invalid value' })
      continue
    }
    // An empty path means "auto-detect", which is the absence of the key rather than "".
    if (value === '') {
      delete document[key]
      applied.push({ key, value: null })
    } else {
      document[key] = value
      applied.push({ key, value })
    }
  }

  if (applied.length === 0) {
    return { ok: rejected.length === 0, applied, rejected }
  }

  try {
    const path = settingsFilePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), applied: [], rejected }
  }

  return { ok: true, applied, rejected }
}

/**
 * Resolve the NeatDM.exe path: an explicit override, then known install locations, then PATH.
 *
 * The same-origin guard that protects the settings write endpoint lives in the route module
 * beside the loopback check, because both are transport concerns rather than download concerns.
 *
 * @param override - an explicit path from settings or the environment, if any.
 * @returns absolute path, or undefined when Neat Download Manager is not installed.
 */
function resolveNdmPath(override) {
  if (override !== undefined && existsSync(override)) return override
  for (const candidate of NDM_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  const located = spawnSync('where', ['NeatDM.exe'], { encoding: 'utf8', windowsHide: true })
  if (located.status === 0) {
    const first = String(located.stdout ?? '').split(/\r?\n/).find((line) => line.trim() !== '')
    if (first !== undefined && existsSync(first.trim())) return first.trim()
  }
  return undefined
}

/** Directory holding per-download task folders. */
function resolveTaskRoot(override) {
  if (override !== undefined) return override
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'NeatDM')
}

/** Directory Neat Download Manager writes finished files into. */
function resolveDownloadDir(override) {
  return override ?? join(homedir(), 'Downloads')
}

/** Task directory names that carry a numeric download id. */
function listTaskIds(taskRoot) {
  if (!existsSync(taskRoot)) return []
  const ids = []
  for (const entry of readdirSync(taskRoot)) {
    if (/^\d+$/.test(entry)) ids.push(Number.parseInt(entry, 10))
  }
  return ids
}

/** Read a file, returning an empty string when it is missing or unreadable. */
function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Total bytes on disk under one task directory (sum of its segment files). */
function taskBytes(taskDir) {
  let total = 0
  try {
    for (const entry of readdirSync(taskDir)) {
      // The task log grows with every retry attempt; counting it would make a stalled
      // transfer look like progress.
      if (/^LogFile\.txt$/i.test(entry)) continue
      try {
        const info = statSync(join(taskDir, entry))
        if (info.isFile()) total += info.size
      } catch {
        /* a segment may vanish between readdir and stat */
      }
    }
  } catch {
    /* task directory may already be gone */
  }
  return total
}

/** Human-readable byte size. */
function human(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

/** Extract `total` from a Content-Range header such as `bytes 0-0/1234`. */
function contentRangeTotal(header) {
  if (header === null) return null
  const match = /\/(\d+)\s*$/.exec(header)
  return match === null ? null : Number.parseInt(match[1], 10)
}

/** Extract a filename from a Content-Disposition header. */
function filenameFromDisposition(header) {
  if (header === null) return undefined
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (extended !== null) {
    try {
      return basename(decodeURIComponent(extended[1].trim().replace(/^"|"$/g, '')))
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain === null ? undefined : basename(plain[1].trim())
}

/** Best-effort filename from a URL path. */
function filenameFromUrl(url) {
  try {
    const parsed = new URL(url)
    const last = basename(parsed.pathname)
    return last === '' || last === '/' ? undefined : decodeURIComponent(last)
  } catch {
    return undefined
  }
}

/**
 * Discover the size and filename of a remote resource without downloading it.
 *
 * A HEAD request is tried first; when the server does not report a length there,
 * a one-byte ranged GET is used and the total is read from Content-Range.
 *
 * @param url - the resource to inspect.
 * @returns size (null when the server will not say) and the best filename guess.
 */
async function probeRemote(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
    let size = Number.parseInt(head.headers.get('content-length') ?? '', 10)
    if (!Number.isFinite(size)) size = null
    let filename =
      filenameFromDisposition(head.headers.get('content-disposition')) ?? filenameFromUrl(head.url || url)

    if (size === null) {
      const ranged = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: controller.signal,
      })
      const total = contentRangeTotal(ranged.headers.get('content-range'))
      if (total !== null) size = total
      if (!Number.isFinite(size)) {
        const len = Number.parseInt(ranged.headers.get('content-length') ?? '', 10)
        if (Number.isFinite(len)) size = len
      }
      filename =
        filename ??
        filenameFromDisposition(ranged.headers.get('content-disposition')) ??
        filenameFromUrl(ranged.url || url)
      if (ranged.body !== null) {
        try {
          await ranged.body.cancel()
        } catch {
          /* the response may already be closed */
        }
      }
    }
    return { size, filename: filename ?? 'download.bin' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download a small resource directly, writing to a temporary sibling and renaming
 * on success so a partial file never looks complete.
 *
 * @param url - the resource.
 * @param outPath - final destination path.
 * @returns the byte count written.
 */
async function downloadDirect(url, outPath) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  if (response.body === null) throw new Error('response carried no body')
  mkdirSync(dirname(outPath), { recursive: true })
  const temporary = `${outPath}.part`
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    rmSync(outPath, { force: true })
    renameSync(temporary, outPath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return statSync(outPath).size
}

/**
 * Terminal-state verdict read from a Neat Download Manager task log.
 *
 * Four outcomes matter and they are not interchangeable:
 *   completed — the file arrived;
 *   cancelled — a person stopped it in Neat Download Manager, which is a decision,
 *               not an error, and must never be reported as a failure;
 *   failed    — Neat Download Manager gave up, and its own reason is surfaced;
 *   running   — no terminal state yet.
 *
 * @param logText - the task's LogFile.txt contents.
 * @returns the classified state plus a diagnostic detail when it is not `running`.
 */
function engineVerdict(logText) {
  if (logText === '') return { state: 'unknown' }

  // A deliberate stop. Neat Download Manager records both a human-readable line and
  // an EngineState of "Paused"; treating Paused as failure is what once turned a
  // user's own cancellation into a misleading "FAIL ... 206" report.
  if (/Download Canceled By User/i.test(logText)) {
    return { state: 'cancelled', detail: 'stopped in Neat Download Manager' }
  }

  // The definitive signal: as the engine shuts down it announces its final state,
  // e.g. "DownloadEngine Is Terminating, EngineState = Completed." or "= Error.".
  // Reading this one line avoids waiting on the stall detector for a failure that
  // Neat Download Manager already reported.
  const terminating = /DownloadEngine Is Terminating,\s*EngineState\s*=\s*([A-Za-z]+)/i.exec(logText)
  if (terminating !== null) {
    const finalState = terminating[1].toLowerCase()
    if (finalState === 'completed') return { state: 'completed' }
    if (finalState === 'paused') {
      return { state: 'cancelled', detail: 'stopped in Neat Download Manager' }
    }
    return { state: 'failed', detail: firstDiagnosticLine(logText, terminating[1]) }
  }
  if (/File completely Downloaded/i.test(logText)) return { state: 'completed' }
  if (
    /->\s*Error\b/i.test(logText) ||
    /->\s*Failed\b/i.test(logText) ||
    /Error Occurred/i.test(logText) ||
    /EngineState\s*=\s*Error\b/i.test(logText)
  ) {
    return { state: 'failed', detail: firstDiagnosticLine(logText, 'Error') }
  }
  if (/EngineState\s*=\s*Stopped\b/i.test(logText)) {
    return { state: 'cancelled', detail: 'stopped in Neat Download Manager' }
  }
  return { state: 'running' }
}

// Exported so the log-classification rules can be regression-tested against real
// Neat Download Manager logs, without needing a live download.
export { engineVerdict }

/** Strip Neat Download Manager's "LEVEL <date> <time> <AM/PM> ( <epoch> )" log prefix. */
function stripLogPrefix(line) {
  return line.replace(/^\s*(INFO|DEBUG|WARN|ERROR)\s+.*?\(\s*\d+\s*\)\s*/i, '').trim()
}

/** Pull the most useful diagnostic line out of a Neat Download Manager log. */
function firstDiagnosticLine(logText, fallbackState) {
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  // Prefer Neat Download Manager's own summary of the failure, then any ERROR line,
  // then the HTTP status line.
  const summary = lines.filter((line) => /Error Occurred\./i.test(line))
  const errors = lines.filter((line) => /^\s*ERROR\b/i.test(line))
  const statuses = lines.filter((line) => /Status Code For Connection/i.test(line))
  const pick = summary.at(-1) ?? errors.at(-1) ?? statuses.at(-1)
  if (pick === undefined) {
    return `Neat Download Manager ended with EngineState = ${fallbackState}`
  }
  const cleaned = stripLogPrefix(pick)
  return (cleaned === '' ? pick : cleaned).slice(0, 300)
}

/**
 * Extract an HTTP refusal status (4xx/5xx) recorded against a connection, if any.
 *
 * Neat Download Manager logs one ERROR line per refused connection, each carrying the
 * offending status, so the most recent one is reported. The pattern is anchored to the
 * `HTTP/1.1 <status>` form on purpose: a bare `[45]\d\d` search would also match digits
 * inside the epoch stamp Neat Download Manager prints in every log line.
 *
 * @param logText - the task's LogFile.txt contents.
 * @returns the status code as a string, or undefined when nothing was refused.
 */
function refusalStatus(logText) {
  if (logText === '') return undefined
  const lines = logText.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!/^\s*ERROR\b/i.test(line)) continue
    const match = /HTTP\/\d(?:\.\d)?\s+([45]\d\d)\b/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Find the file Neat Download Manager produced.
 *
 * Size is the trustworthy signal. When the probe discovered an expected size, only a
 * file of exactly that size counts — whatever name the downloader chose. The earlier
 * "newest file in the directory" fallback was applied unconditionally, which let a
 * 1.5 KiB HTML error page be reported as a successful 4.4 GiB download; it is now
 * used only when the expected size is genuinely unknown. Returning undefined makes
 * the caller report a failure, which is the honest outcome when nothing of the right
 * size appeared.
 *
 * @param downloadDir - directory to search.
 * @param expectedName - filename derived from Content-Disposition or the URL.
 * @param startedAt - epoch ms when the task was launched.
 * @param expectedSize - known size, or null when the server would not say.
 * @returns the matched entry, or undefined when no candidate qualifies.
 */
function locateResult(downloadDir, expectedName, startedAt, expectedSize) {
  if (!existsSync(downloadDir)) return undefined

  const fresh = []
  for (const entry of readdirSync(downloadDir)) {
    const path = join(downloadDir, entry)
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      // Ignore anything that predates this task, and any in-progress artefact.
      if (info.mtimeMs < startedAt - 5000) continue
      if (/\.(part|tmp|incomplete|ndm)$/i.test(entry)) continue
      fresh.push({ path, name: entry, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      /* skip entries that disappear */
    }
  }
  if (fresh.length === 0) return undefined

  if (expectedSize !== null && expectedSize > 0) {
    const named = fresh.find((item) => item.name === expectedName && item.size === expectedSize)
    if (named !== undefined) return named
    const anyExactSize = fresh.find((item) => item.size === expectedSize)
    if (anyExactSize !== undefined) return anyExactSize
    return undefined
  }

  const named = fresh.find((item) => item.name === expectedName)
  if (named !== undefined) return named

  fresh.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return fresh[0]
}

/**
 * Largest file written since the task started, used to diagnose a size mismatch.
 * @param downloadDir - directory to search.
 * @param startedAt - epoch ms when the task was launched.
 * @returns the entry, or undefined when nothing new appeared.
 */
function largestStray(downloadDir, startedAt) {
  if (!existsSync(downloadDir)) return undefined
  let best
  for (const entry of readdirSync(downloadDir)) {
    const path = join(downloadDir, entry)
    try {
      const info = statSync(path)
      if (!info.isFile() || info.mtimeMs < startedAt - 5000) continue
      if (/\.(part|tmp|incomplete|ndm)$/i.test(entry)) continue
      if (best === undefined || info.size > best.size) best = { path, name: entry, size: info.size }
    } catch {
      /* skip */
    }
  }
  return best
}

/**
 * Hand a URL to Neat Download Manager, wait for the task to finish, and report
 * Neat Download Manager's own verdict when it fails.
 *
 * @param url - the resource.
 * @param probe - size and filename discovered before routing.
 * @param context - resolved paths, threshold and per-call wait budget.
 * @returns a compact status string.
 */
async function viaNeatDm(url, probe, context) {
  const {
    ndmPath,
    taskRoot,
    downloadDir,
    maxWaitMs,
    monitor,
    pollIntervalMs,
    stallTimeoutMs,
    taskAppearTimeoutMs,
    settleMs,
    onProgress,
  } = context
  const before = new Set(listTaskIds(taskRoot))
  const startedAt = Date.now()

  const child = spawn(ndmPath, [url], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()

  // Wait for Neat Download Manager to open a task directory for this URL.
  let taskId
  const appearDeadline = Date.now() + taskAppearTimeoutMs
  while (Date.now() < appearDeadline) {
    const fresh = listTaskIds(taskRoot).filter((id) => !before.has(id))
    if (fresh.length > 0) {
      taskId = Math.max(...fresh)
      break
    }
    await sleep(400)
  }

  if (taskId === undefined) {
    // The handoff failed, or the transfer completed so fast the task directory was
    // already reclaimed. Accept a finished file only when its size proves it.
    const settled = locateResult(downloadDir, probe.filename, startedAt, probe.size)
    if (settled !== undefined) {
      return `OK ${human(settled.size)} -> ${settled.path} (NDM, task directory not observed)`
    }
    return (
      'FAIL Neat Download Manager did not open a task for this URL within ' +
      `${Math.round(taskAppearTimeoutMs / 1000)}s. Check that ${ndmPath} is running and ` +
      'that its browser integration is enabled.'
    )
  }

  const taskDir = join(taskRoot, String(taskId))
  const logPath = join(taskDir, 'LogFile.txt')

  // "monitor: none" — hand off and return immediately. The whole point is that the
  // caller does not pay for progress it does not want; Neat Download Manager's own
  // window is the progress display.
  if (monitor === 'none') {
    const expected = join(downloadDir, probe.filename)
    return (
      `STARTED NDM task ${taskId} -> expects ${expected}` +
      (probe.size === null ? '' : ` (${human(probe.size)})`) +
      '. Monitoring is off; it continues in Neat Download Manager.'
    )
  }

  const deadline = Date.now() + maxWaitMs
  let verdict = { state: 'running' }
  let lastBytes = 0
  let stableSince = Date.now()
  let lastLogText = ''

  while (Date.now() < deadline) {
    const logText = readTextSafe(logPath)
    lastLogText = logText
    verdict = engineVerdict(logText)
    if (verdict.state === 'completed' || verdict.state === 'failed' || verdict.state === 'cancelled') break

    const bytes = taskBytes(taskDir)
    if (bytes !== lastBytes) {
      lastBytes = bytes
      stableSince = Date.now()
      // Surface the running byte count to the status registry, which is what a progress UI
      // reads. Neat Download Manager's own window shows the same figure.
      if (onProgress !== undefined) onProgress(bytes, probe.size)
    } else if (Date.now() - stableSince > stallTimeoutMs && logText !== '') {
      // Last resort, for a task that neither reports a terminal state nor moves any
      // bytes: a genuine hang rather than a failure Neat Download Manager already named.
      verdict = {
        state: 'failed',
        detail: `no progress for ${Math.round(stallTimeoutMs / 60000)} minutes; the task appears stalled`,
      }
      break
    }
    await sleep(pollIntervalMs)
  }

  if (verdict.state === 'running') {
    // Still in flight, so no file exists yet — but a caller that only reads the result
    // must still learn where the transfer is heading, not merely that it is unfinished.
    return (
      `TIMEOUT still downloading: NDM task ${taskId}, ${human(lastBytes)} received so far. ` +
      `Expected to land at ${join(downloadDir, probe.filename)}. ` +
      `It continues in Neat Download Manager; call download_file again with waitSeconds set to check again.`
    )
  }

  if (verdict.state === 'cancelled') {
    // A deliberate stop is a decision, not an error, so it is never dressed up as a
    // download failure. But a task can be cancelled *while* the server was refusing
    // it, and losing that fact would hide the real obstacle — so it is reported too.
    const refusal = refusalStatus(lastLogText)
    const note =
      refusal === undefined
        ? ''
        : ` The server had also been refusing the request (HTTP ${refusal}), so it was not progressing anyway.`
    return (
      `CANCELLED NDM task ${taskId}: ${verdict.detail} after ${human(lastBytes)} ` +
      `(${Math.round((Date.now() - startedAt) / 1000)}s).${note} Nothing was saved.`
    )
  }

  if (verdict.state === 'failed') {
    const detail = verdict.detail
    // An HTTP status at or above 400 usually means the server refused the downloader
    // rather than a network fault, which is worth saying so the next step is obvious.
    const refused = /=\s*([45]\d\d)\b/.exec(detail)
    const hint =
      refused === null
        ? ''
        : ' The server refused the request; many mirrors reject download managers that impersonate a browser or open many connections.'
    return `FAIL NDM task ${taskId}: ${detail}${hint}`
  }

  // Engine says completed: confirm the artifact exists, at the right size.
  const result = locateResult(downloadDir, probe.filename, startedAt, probe.size)
  if (result === undefined) {
    // Neat Download Manager considered this a success, but nothing of the expected
    // size is on disk. The common cause is a server that answers the downloader with
    // an error or interstitial page under a 200 status: some mirrors reject a
    // browser-spoofing User-Agent this way rather than with a 403.
    const stray = largestStray(downloadDir, startedAt)
    const expected = probe.size === null ? 'the expected size' : human(probe.size)
    if (stray !== undefined) {
      // Report the full path, not just the basename: a caller that only reads this line
      // still needs to know exactly which file was written and where. The junk is then
      // removed, because leaving an error page sitting in someone's downloads folder to
      // look like a real file is its own kind of failure.
      const cleanup = cleanUpArtifacts(downloadDir, startedAt, probe.filename, probe.size, [])
      return (
        `FAIL NDM task ${taskId} finished but the artifact is wrong: expected ${expected} at ` +
        `${join(downloadDir, probe.filename)}, largest new file was ${human(stray.size)} (${stray.path}). ` +
        'The server probably served an error or interstitial page instead of the file — ' +
        `a 200 response carrying text/html where a binary was expected. Try another mirror.${cleanup}`
      )
    }
    return (
      `FAIL NDM task ${taskId} reported Completed, but no finished file of the expected size ` +
      `appeared in ${downloadDir} (looked for ${probe.filename}). ` +
      'Set DSH_NDM_DIR to the directory Neat Download Manager actually saves into.'
    )
  }
  let previous = -1
  for (let attempt = 0; attempt < 6 && previous !== result.size; attempt += 1) {
    previous = result.size
    await sleep(settleMs)
    try {
      result.size = statSync(result.path).size
    } catch {
      break
    }
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  return `OK ${human(result.size)} -> ${result.path} (NDM task ${taskId}, ${seconds}s)`
}

/**
 * Resolve the final path a download should be written to.
 *
 * `dest` is treated as a directory when it already is one, or when it ends with a path
 * separator — and in that case the remote filename is appended. Otherwise it names the
 * file itself.
 *
 * Deciding purely on "does it already exist" was a trap for any caller that had not
 * created the directory yet: `dest: "D:/models/gguf"` was silently written as a FILE
 * named `gguf`. A trailing separator is an explicit, unambiguous signal, so it is
 * honoured even when the directory does not exist yet.
 *
 * @param dest - the caller's destination, or undefined.
 * @param filename - the remote filename, used when dest is a directory.
 * @param defaultDir - directory used when dest is omitted.
 * @returns the absolute path to write.
 */
function resolveTarget(dest, filename, defaultDir) {
  if (dest === undefined || dest === '') return join(defaultDir, filename)

  const absolute = isAbsolute(dest) ? dest : resolve(process.cwd(), dest)
  if (/[\\/]$/.test(dest)) return join(absolute, filename)

  if (existsSync(absolute)) {
    try {
      if (statSync(absolute).isDirectory()) return join(absolute, filename)
    } catch {
      /* fall through and treat it as a file path */
    }
  }
  return absolute
}

/** Move or copy the finished file to an explicitly requested destination. */
function placeAt(sourcePath, dest) {
  const target = resolveTarget(dest, basename(sourcePath), dirname(sourcePath))
  if (resolve(target) === resolve(sourcePath)) return { path: target, moved: false }
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(sourcePath, target)
  } catch {
    // Different volume: fall back to a streaming copy so multi-gigabyte files survive.
    copyFileSync(sourcePath, target)
    rmSync(sourcePath, { force: true })
  }
  return { path: target, moved: true }
}

/**
 * Relocate a finished download to where the caller asked for it, then prove it landed.
 *
 * Neat Download Manager has no command-line option for a save directory — the only way to
 * put a file somewhere specific is to let it download where it likes and move the result.
 * That makes the move part of the contract, so it is verified rather than assumed: the
 * destination must exist at the expected size and the source must be gone, otherwise the
 * caller is told plainly instead of being handed a path that is not true.
 *
 * @param sourcePath - where Neat Download Manager put the file.
 * @param dest - the caller's destination (file or directory).
 * @param expectedSize - the probed size, or null when unknown.
 * @returns a note to append to the result, plus whether the relocation succeeded.
 */
function relocate(sourcePath, dest, expectedSize) {
  const target = resolveTarget(dest, basename(sourcePath), dirname(sourcePath))

  if (resolve(target) === resolve(sourcePath)) {
    return { note: '', path: target, ok: true }
  }

  let moved
  try {
    moved = placeAt(sourcePath, dest)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const hint = /\b(ENOTDIR|EEXIST|ENOENT|EPERM|EACCES)\b/.test(detail)
      ? ' If dest was meant to be a directory, end it with a path separator (\\ or /).'
      : ''
    return { note: '', path: sourcePath, ok: false, error: `could not move to ${target}: ${detail}${hint}` }
  }

  // Prove the move rather than trusting it.
  const problems = []
  if (!existsSync(moved.path)) {
    problems.push('the destination does not exist after the move')
  } else {
    const landed = statSync(moved.path).size
    if (expectedSize !== null && landed !== expectedSize) {
      problems.push(`destination is ${human(landed)} but ${human(expectedSize)} was expected`)
    }
  }
  if (existsSync(sourcePath)) {
    // A copy fallback that failed to clean up would leave a full duplicate behind.
    try {
      rmSync(sourcePath, { force: true })
    } catch {
      /* reported below if it survives */
    }
    if (existsSync(sourcePath)) problems.push(`the original was left behind at ${sourcePath}`)
  }

  if (problems.length > 0) {
    return { note: '', path: moved.path, ok: false, error: `moved to ${moved.path} but ${problems.join('; ')}` }
  }
  return { note: ` (moved from ${sourcePath})`, path: moved.path, ok: true }
}

/**
 * Delete the files a failed or redirected download left behind that nobody wants.
 *
 * Candidates are scoped by three independent conditions, and a file must satisfy all of
 * them, so nothing unrelated can be caught:
 *
 *   1. **fresh** — written since this task started. A same-named file from an earlier
 *      download belongs to somebody else's work and is never touched.
 *   2. **name-shaped-like-ours** — exactly the expected filename, or that filename's stem
 *      followed by an optional ` (N)` and a single extension. That shape covers what Neat
 *      Download Manager actually produces (`ubuntu-...amd64(1).html` when a mirror answers
 *      with an error page) while excluding neighbours such as `....iso.sha256`, which has
 *      two extension segments and so does not match.
 *   3. **size disagrees** with the probed size. A file of the correct size is the download,
 *      not junk, and is left alone even if its extension seems surprising.
 *
 * @param downloadDir - directory to sweep.
 * @param startedAt - epoch ms when the task was launched.
 * @param expectedName - the filename the download was supposed to produce.
 * @param expectedSize - the probed size, or null when the server would not say.
 * @param extraPaths - further exact paths to remove unconditionally.
 * @returns a short description of what was removed, for the result line.
 */
function cleanUpArtifacts(downloadDir, startedAt, expectedName, expectedSize, extraPaths) {
  const removed = []

  const drop = (path) => {
    try {
      rmSync(path, { force: true })
      removed.push(basename(path))
      return true
    } catch {
      return false // a locked file is not worth failing the call over
    }
  }

  for (const candidate of extraPaths) {
    if (candidate === undefined || !existsSync(candidate)) continue
    drop(candidate)
  }

  if (!existsSync(downloadDir)) {
    return removed.length === 0 ? '' : ` Cleaned up ${removed.join(', ')}.`
  }

  const stem = expectedName.replace(/\.[^.]+$/, '')
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namePattern = new RegExp(`^${escaped}( \\(\\d+\\))?\\.[A-Za-z0-9]+$`)

  for (const entry of readdirSync(downloadDir)) {
    if (!namePattern.test(entry)) continue
    const path = join(downloadDir, entry)
    let info
    try {
      info = statSync(path)
      if (!info.isFile()) continue
      if (info.mtimeMs < startedAt - 5000) continue
    } catch {
      continue
    }
    if (expectedSize !== null && info.size === expectedSize) continue
    if (removed.includes(entry)) continue
    drop(path)
  }

  return removed.length === 0 ? '' : ` Cleaned up ${removed.join(', ')}.`
}

/**
 * Register the `download_file` tool.
 *
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx) {
  // Publish a documented settings file on first load so the knobs are discoverable
  // without reading the source. Never overwrites an existing file.
  ensureSettingsFile()
  const thresholdBytes = loadSettings().thresholdBytes

  // The status registry the download panel reads. It writes a small JSON file beside the
  // settings file, so a panel inside dsh, a viewer outside it, and a person with a text
  // editor all see the same live state. Recording is best-effort and costs no tokens: the
  // tool still returns one short line and the model never sees any of this.
  //
  // `restore` adopts what a previous dsh process left in that file. Without it the panel would
  // start blank after every restart — and restarts are routine here — while an entry the previous
  // process still called in-flight is re-recorded as interrupted rather than shown as live.
  const dshHome = envString('DSH_HOME', join(homedir(), '.dsh'))
  // `DSH_NDM_STATUS` redirects the mirror on its own, without moving where settings are read from.
  // That distinction exists for test hygiene: a suite performing real downloads can leave the
  // history the user's panel shows untouched while still exercising the settings file it means to
  // test. Without it, every test run adds rows to a panel that is supposed to describe real work.
  const status = createStatusStore({
    path: envString('DSH_NDM_STATUS', statusFilePath(dshHome)),
    restore: true,
  })

  // Housekeeping once per start: partial transfers past their retention window are removed. This
  // is what stops an interrupted download from leaving a `.part` in someone's folder for good. It
  // only ever considers the exact paths this plugin writes, for destinations it recorded itself.
  sweepStalePartials(status, loadSettings().partialRetentionDays)

  // Steer the model toward this tool so routing is automatic rather than a habit it
  // has to remember. The system-prompt service is an optional dependency: the tool
  // still registers and works when it is absent.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'dsh-download:policy',
        order: 45,
        text:
          'Downloads: use download_file for any file download, and never print or poll ' +
          "a download's progress output.",
      }),
    )
  }

  // ---- endpoints behind the download panel ------------------------------------------------
  //
  // The panel lives in the browser, so what it draws — and what the user types into it — has to
  // cross the host boundary. The shipped route for that is a Typert remote service, which needs a
  // decorator and a build step and pins the plugin to one protocol version; this plugin is
  // hand-written with zero dependencies, so plain routes are registered on the host's HTTP server
  // instead.
  //
  // The panel is read/write. An earlier revision served reads only, which made it a status page
  // rather than a settings UI: the people who need to change the threshold are exactly the people
  // who will never open a JSON file. Writes are validated here through `writeSettingsPatch`'s
  // allow-list, and gated in the route module on a loopback peer plus a same-origin request.
  //
  // Everything here is deliberately defensive. `webServer` is an OPTIONAL dependency requested
  // through a scoped `inject` rather than the plugin's `inject` list: a host that has no web
  // surface must still get the tool, and a webserver that becomes available later must still get
  // the panel. Registration is wrapped, because a failure to publish a status page can never be
  // allowed to take down the tool that does the actual work.
  const registerUiRoutes = (host) => {
    if (host === undefined || host === null || typeof host.register !== 'function') return
    try {
      ctx.effect(
        () =>
          createUiRoutes({
            status,
            loadSettings,
            writeSettingsPatch,
            resolveNdmPath,
            resolveDownloadDir,
            resolveTaskRoot,
          }).map((route) => host.register(route)),
        'dsh-download: ui routes',
      )
    } catch {
      /* the download tool works with or without a panel */
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (uiCtx) => registerUiRoutes(uiCtx.get('webServer')))
  } else {
    // Older or stubbed contexts have no scoped inject; a direct lookup is the honest fallback.
    registerUiRoutes(ctx.get('webServer'))
  }

  ctx.tools.register({
    name: 'download_file',
    description:
      'Download a URL to disk. 1 GiB or more routes through Neat Download Manager, smaller ' +
      'files directly. dest gives the exact final path and is verified; without it the file ' +
      'lands in the system Downloads folder. Blocks until finished, then returns the absolute ' +
      'path written. Prefer over curl/wget for any download.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'URL to download.',
        },
        dest: {
          type: 'string',
          description: 'File path or directory to write to; defaults to the Downloads folder.',
        },
        force: {
          type: 'boolean',
          description: 'Force Neat Download Manager below 1 GiB.',
        },
        waitSeconds: {
          type: 'integer',
          description: 'Cap the wait in seconds; omit to wait until done.',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    isConcurrencySafe: true,
    async execute(args) {
      const url = args.url
      // Used to scope cleanup: only files written since this call began can be this call's
      // leftovers.
      const callStartedAt = Date.now()
      const dest = typeof args.dest === 'string' && args.dest !== '' ? args.dest : undefined
      const force = args.force === true
      const waitSeconds =
        typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) && args.waitSeconds > 0
          ? args.waitSeconds
          : undefined

      // Read settings on every call, not once at load: an edit to the settings file then
      // takes effect on the next download instead of needing a dsh restart.
      const settings = loadSettings()
      const downloadDir = resolveDownloadDir(settings.downloadDir)
      const taskRoot = resolveTaskRoot(settings.taskRoot)
      const ndmPath = resolveNdmPath(settings.ndmPath)
      const prefix = settings.problem === undefined ? '' : `WARNING ${settings.problem}. `
      const thresholdBytes = settings.thresholdBytes

      /** Discover size and name, tolerating a server that refuses to be probed. */
      let probe
      try {
        probe = await probeRemote(url)
      } catch (error) {
        probe = { size: null, filename: filenameFromUrl(url) ?? 'download.bin', probeError: error }
      }

      const size = probe.size
      const routeToNdm = force || (size !== null && size >= thresholdBytes)

      // ---- built-in engine ------------------------------------------------------------
      // Chosen by default. It is in-process (nothing to install), picks its own User-Agent
      // (so mirrors that refuse browser spoofing serve it), and writes straight to the
      // requested destination — no download elsewhere followed by a move.
      //
      // `thresholdBytes` maps onto it as "the size at which full parallelism kicks in":
      // a file of exactly that size is split into `builtinConnections` segments, and
      // smaller files get fewer, down to a single stream.
      // `force` is documented as "route through Neat Download Manager even below the size
      // threshold". Once the built-in engine became the default, gating this branch on the engine
      // setting alone made `force` a silent no-op — an argument that does nothing is worse than one
      // that does not exist, because a caller has no way to tell. Honouring it here also gives the
      // NDM path a per-call override without changing the machine-wide setting.
      if (settings.engine !== 'ndm' && !force) {
        const destPath = resolveTarget(dest, probe.filename, downloadDir)
        const minSegmentBytes = Math.max(
          1,
          Math.floor(thresholdBytes / Math.max(1, settings.builtinConnections)),
        )

        // The planned connection count is recorded up front so the panel can show a narrow,
        // honest figure for a transfer that has not reported anything yet.
        const record = status.begin({
          url,
          dest: destPath,
          engine: 'built-in',
          total: probe.size,
          connections: settings.builtinConnections,
        })

        let outcome
        try {
          outcome = await downloadSegmented(url, destPath, {
            connections: settings.builtinConnections,
            minSegmentBytes,
            // A retention of zero means the user would rather never see a partial than be able to
            // resume one, so the engine is told not to keep any.
            keepPartial: settings.partialRetentionDays > 0,
            // `waitSeconds` bounds the wait for this engine too, and stopping is no longer
            // wasteful: what has arrived stays on disk and the next call continues from it.
            waitMs: waitSeconds === undefined ? undefined : waitSeconds * 1000,
            // Feeds the status file a UI reads. Wrapped because status recording must never be
            // able to break a transfer.
            onProgress: (received, total) => status.progress(record.id, { bytes: received, total }),
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          status.finish(record.id, { ok: false, error: detail })
          return `${prefix}FAIL built-in engine: ${detail}`
        }

        // A wait that ran out is not a failure: nothing is broken, the caller simply asked to be
        // given control back, and the transfer is waiting to be continued.
        if (outcome.timedOut === true) {
          const partial = outcome.partial
          status.finish(record.id, {
            ok: false,
            cancelled: true,
            error: `stopped after waiting ${waitSeconds}s; the partial transfer is resumable`,
          })
          return (
            `${prefix}TIMEOUT still downloading: built-in engine reached ` +
            `${human(outcome.bytes ?? 0)} of ${human(outcome.total ?? 0)} in ${waitSeconds}s. ` +
            (partial === undefined
              ? 'Nothing was kept: too little had arrived to be worth resuming.'
              : // `partial.path` is already the staged name; appending the suffix again once produced
                // a message naming a file nobody would ever find (`….iso.part.part`).
                `A partial transfer is kept at ${partial.path}; call download_file again with the same dest to resume it.`)
          )
        }

        if (!outcome.ok) {
          status.finish(record.id, { ok: false, error: outcome.error, hint: outcome.hint })
          // A partial transfer is no longer junk: it is the state a later call continues from. A
          // caller that is not told this would download the whole file again, so the location and
          // the follow-up are stated plainly.
          const kept =
            outcome.partial === undefined
              ? ''
              : ` A partial transfer is kept at ${outcome.partial.path}` +
                (typeof outcome.partial.bytes === 'number' && typeof outcome.partial.total === 'number'
                  ? ` (${human(outcome.partial.bytes)} of ${human(outcome.partial.total)})`
                  : '') +
                '; calling download_file again resumes it.'
          return `${prefix}FAIL built-in engine: ${outcome.error}${outcome.hint ?? ''}${kept}`
        }

        // The finished figure replaces the plan: a segmented transfer is split across as many
        // connections as the server's ranges allowed, which is not always the number asked for.
        status.finish(record.id, {
          ok: true,
          bytes: outcome.bytes,
          method: outcome.method,
          dest: destPath,
          connections: outcome.method === 'segmented' ? outcome.segments : 1,
        })

        const how =
          outcome.method === 'segmented'
            ? `segmented x${outcome.segments}`
            : `single-stream, ${outcome.reason ?? 'no ranges'}`
        // Say when a transfer continued earlier work, so the figure is not read as this run's own
        // achievement.
        const resumed =
          typeof outcome.resumedBytes === 'number' && outcome.resumedBytes > 0 && outcome.bytes > 0
            ? `, resumed from ${Math.round((outcome.resumedBytes / outcome.bytes) * 100)}%`
            : ''
        const seconds = Math.round((outcome.elapsedMs ?? 0) / 1000)
        return `${prefix}OK ${human(outcome.bytes)} -> ${destPath} (built-in, ${how}${resumed}, ${seconds}s)`
      }

      // ---- Neat Download Manager engine -----------------------------------------------
      if (routeToNdm) {
        if (ndmPath === undefined) {
          return (
            `${prefix}FAIL Neat Download Manager was not found. Install it, or set ndmPath in ` +
            `${settings.path}, or the DSH_NDM_PATH environment variable.`
          )
        }

        // A requested destination implies waiting. Neat Download Manager has no
        // command-line option for a save directory, so honouring `dest` means moving the
        // file afterwards — and there is nothing to move until the transfer finishes.
        // Overriding "monitor: none" here is the only way to keep the promise, and the
        // override is stated in the result so it is never invisible.
        const relocationRequested = dest !== undefined
        const forcedToWait = relocationRequested && settings.monitor === 'none'

        // Named `ndmStatus`, not `status`: a local `status` here would shadow the status
        // registry declared in apply(), and every recording call below would then throw.
        const record = status.begin({ url, dest: dest ?? join(downloadDir, probe.filename), engine: 'ndm', total: probe.size })

        const ndmStatus = await viaNeatDm(url, probe, {
          ndmPath,
          taskRoot,
          downloadDir,
          maxWaitMs: (waitSeconds ?? Number.POSITIVE_INFINITY) * 1000,
          monitor: forcedToWait ? 'block' : settings.monitor,
          pollIntervalMs: settings.pollIntervalMs,
          stallTimeoutMs: settings.stallTimeoutMs,
          taskAppearTimeoutMs: settings.taskAppearTimeoutMs,
          settleMs: settings.settleMs,
          onProgress: (bytes, total) => status.progress(record.id, { bytes, total }),
        })
        const waitNote = forcedToWait ? ' (monitoring forced on to honour dest)' : ''

        if (ndmStatus.startsWith('FAIL')) {
          status.finish(record.id, { ok: false, error: ndmStatus.replace(/^FAIL\s*/, '') })
          return `${prefix}${ndmStatus}${waitNote}`
        }
        if (ndmStatus.startsWith('CANCELLED')) {
          status.finish(record.id, { ok: false, cancelled: true, error: ndmStatus })
          return `${prefix}${ndmStatus}${waitNote}`
        }

        if (ndmStatus.startsWith('OK') && relocationRequested) {
          const located = /-> (.+?) \(NDM/.exec(ndmStatus)
          if (located !== null) {
            const moved = relocate(located[1], dest, probe.size)
            if (!moved.ok) {
              // Never report a path that is not true: the whole point of `dest` is that the
              // caller can rely on it.
              status.finish(record.id, { ok: false, error: `download finished but ${moved.error}` })
              return `${prefix}FAIL download finished but ${moved.error}`
            }
            const cleanup = cleanUpArtifacts(
              downloadDir,
              callStartedAt,
              probe.filename,
              probe.size,
              [`${located[1]}.part`],
            )
            status.finish(record.id, { ok: true, bytes: probe.size ?? undefined, method: 'ndm', dest: moved.path })
            return `${prefix}${ndmStatus.replace(located[1], moved.path)}${moved.note}${waitNote}${cleanup}`
          }
        }
        if (ndmStatus.startsWith('OK')) {
          status.finish(record.id, { ok: true, bytes: probe.size ?? undefined, method: 'ndm' })
        }
        return `${prefix}${ndmStatus}${waitNote}`
      }

      // Small file, Neat Download Manager engine selected: fetch it directly.
      const finalPath = resolveTarget(dest, probe.filename, downloadDir)
      const directRecord = status.begin({ url, dest: finalPath, engine: 'direct', total: size, connections: 1 })
      try {
        const bytes = await downloadDirect(url, finalPath)
        status.finish(directRecord.id, { ok: true, bytes, method: 'direct', dest: finalPath })
        const note =
          size === null
            ? ' (size unknown before download, so the direct path was used; pass force to override)'
            : ''
        return `${prefix}OK ${human(bytes)} -> ${finalPath} (direct)${note}`
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // ENOTDIR/EEXIST/ENOENT here nearly always mean `dest` was intended as a
        // directory but named a file path, or names a file where a directory is needed.
        // Raw Node error text is unhelpful to any caller, so the likely fix is spelled out.
        const hint = /\b(ENOTDIR|EEXIST|ENOENT|EPERM)\b/.test(detail)
          ? ' If dest was meant to be a directory, end it with a path separator (\\ or /).'
          : ''
        status.finish(directRecord.id, { ok: false, error: detail, hint })
        return `${prefix}FAIL direct download: ${detail}${hint}`
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Download ${filenameFromUrl(args.url) ?? 'file'}`,
        kind: 'other',
        rawInput: args.url,
      }
    },
  })
}
