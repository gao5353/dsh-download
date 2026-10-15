/**
 * Built-in segmented HTTP download engine for dsh-download.
 *
 * Why this exists alongside Neat Download Manager
 * -----------------------------------------------
 * Neat Download Manager is battle-tested but it is an external Windows program with three
 * practical costs: it must be installed, it decides the User-Agent itself (which several
 * mirrors reject with 403 for spoofing a browser), and it always saves into its own
 * directory — so honouring a requested destination means downloading somewhere else and
 * moving the file afterwards. This engine removes all three: it is in-process, it chooses
 * its own headers, and it writes straight to the requested path.
 *
 * Design notes
 * ------------
 * - **Positioned writes, no segment files and no merge step.** Each worker fetches a byte
 *   range and writes it directly into the final file at its own offset via
 *   `FileHandle.write(buffer, offset, length, position)`. Neat Download Manager instead
 *   writes `seg.xN` files and merges them at the end, which doubles peak disk usage and
 *   leaves those files behind when a transfer is abandoned.
 * - **Nothing is written until the response is known to be a real file.** Status, content
 *   type and length are validated first, so an error or interstitial page a mirror serves
 *   under a 200 status never becomes a file on disk. That failure mode cost real debugging
 *   time with Neat Download Manager, which writes whatever it receives.
 * - **Adaptive on refusal.** A 403 rotates the User-Agent; a 418 or 429 — the "too many
 *   connections" answers some mirrors give — halves the concurrency and retries instead of
 *   failing the transfer.
 * - **Fails loudly.** Every failure returns a reason, and an optional detail log can be
 *   written to disk so the user or an agent can inspect what happened.
 *
 * @module dsh-download/engine-builtin
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** User-Agents tried in order. Tool agents first: several mirrors reject browser spoofing. */
const DEFAULT_AGENTS = [
  'curl/8.21.0',
  'Wget/1.21.4',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

/**
 * Content types that mean "a web page", which is never the artifact a download asked for.
 *
 * A page is refused on the label alone, because there is no HTML file that a download commonly
 * wants in place of something else.
 */
const PAGE_TYPE = /^(text\/html|application\/xhtml\+xml)/i

/**
 * Content types that could be a real text file — source code, a script, a config, a data file — and
 * could equally be an error page wearing the wrong label. Neither the type nor the URL extension
 * separates those two, so the opening bytes are read instead.
 *
 * Treating every one of these as a page made this engine refuse `pyinstxtractor.py` and a Ren'Py
 * `.rpy` script: both are text/plain, neither URL ends in a document extension, and both are far
 * below the size at which a large body would have been believed. An agent fetching source code hit
 * a wall that a plain `curl` walked straight through.
 */
const TEXT_LIKE_TYPE = /^(text\/|application\/(?:json|xml)\b)/i

/** The opening bytes of an HTML document, tolerating leading whitespace or a byte order mark. */
const PAGE_HEAD = /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<meta[\s>])/i

/** URLs that legitimately ask for a document, so a document response is expected. */
const DOCUMENT_PATH = /\.(html?|txt|xml|json|md|csv)$/i

/** Default parallel connections. Mirrors that answer 418 get this halved automatically. */
const DEFAULT_CONNECTIONS = 16

/** Fail the transfer after this many unproductive retries across all workers. */
const DEFAULT_MAX_RETRIES = 4

/** Smallest useful segment; below this, splitting costs more than it saves. */
const MIN_SEGMENT_BYTES = 1024 * 1024

/**
 * Bytes gathered per positioned write.
 *
 * A response body arrives in ~64 KiB pieces; writing each one where it lands is what makes some
 * volumes collapse (measured: 1.6 MiB in 48 s at 64 KiB writes against 5371 MiB in 45 s at
 * 1 MiB writes, same concurrency, same file). One megabyte keeps 16 workers inside a few MiB of
 * memory each while turning every 16 socket reads into a single write.
 */
const DEFAULT_WRITE_CHUNK_BYTES = 1024 * 1024

/**
 * How often the resume state is flushed while a transfer runs.
 *
 * A segment's completion is always recorded; this bounds the extra writes for progress inside a
 * segment, so a long transfer does not rewrite the state file on every megabyte.
 */
const RESUME_FLUSH_MS = 2000

/** Suffix of the staged working file. The destination name appears only once it is complete. */
const PART_SUFFIX = '.part'

/** Suffix of the resume state beside the staged file. */
const RESUME_SUFFIX = '.part.json'

/** Sleep helper. */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** Human-readable size. */
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

/** Extract the total from a Content-Range header such as `bytes 0-1/1234`. */
function contentRangeTotal(header) {
  if (header === null) return null
  const match = /\/(\d+)\s*$/.exec(header)
  return match === null ? null : Number.parseInt(match[1], 10)
}

/** Extract a filename from Content-Disposition. */
function filenameFromDisposition(header) {
  if (header === null) return undefined
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, '')).split(/[\\/]/).pop()
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain === null ? undefined : plain[1].trim().split(/[\\/]/).pop()
}

/** Best-effort filename from a URL path. */
function filenameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    return last === '' ? undefined : last
  } catch {
    return undefined
  }
}

/**
 * Inspect a URL before committing to a strategy.
 *
 * A plain GET with `Range: bytes=0-1` is preferred over HEAD because it reveals
 * Accept-Ranges and the content type reliably, and costs two bytes rather than trusting a
 * HEAD response that some servers answer inconsistently.
 *
 * @param url - the resource.
 * @param userAgent - the agent to send.
 * @returns status, size, range support, type and filename.
 */
async function inspect(url, userAgent) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': userAgent, Range: 'bytes=0-1' },
  })

  const status = response.status
  const contentType = response.headers.get('content-type')
  const disposition = response.headers.get('content-disposition')
  const rangeHeader = response.headers.get('content-range')
  let size = null

  // Trust Content-Range whenever it is present, not only on a 206. Some servers (ModelScope,
  // for one) answer a ranged request with status 200, a body of exactly the requested bytes,
  // and a correct `bytes 0-1/411`. Keying off the status alone read Content-Length as 2 and
  // concluded the file was two bytes long.
  const total = contentRangeTotal(rangeHeader)
  if (total !== null) {
    size = total
  } else {
    const length = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(length)) size = length
  }

  // Drain the tiny body so the socket is not left hanging.
  if (response.body !== null) {
    try {
      for await (const _chunk of response.body) break
      await response.body.cancel()
    } catch {
      /* already closed */
    }
  }

  return {
    status,
    contentType,
    disposition,
    size,
    // A server supports ranges if it answered 206, or answered 200 while still honouring the
    // range it was asked for.
    ranges: status === 206 || (status === 200 && rangeHeader !== null),
    // Validators, when offered. These are what make a resume trustworthy rather than hopeful: they
    // answer "is the remote file still the version whose bytes are already on disk?".
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    filename:
      filenameFromDisposition(disposition) ??
      filenameFromUrl(response.url || url) ??
      'download.bin',
    finalUrl: response.url || url,
  }
}

/**
 * Decode a fetch body into a stream of Buffers.
 * @param body - the response body.
 */
async function* bodyChunks(body) {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield Buffer.from(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * The staged working file for a destination. `<dest>.part`.
 * @param destPath - the destination the caller asked for.
 */
export function stagedPathFor(destPath) {
  return `${destPath}${PART_SUFFIX}`
}

/** The resume state beside a staged file. `<dest>.part.json`. */
export function resumePathFor(destPath) {
  return `${destPath}${RESUME_SUFFIX}`
}

/**
 * Read a resume state, accepting it only when it provably describes this same transfer.
 *
 * Resuming is the one place where being wrong is worse than being slow: bytes already on disk are
 * spliced together with bytes about to arrive, and a bad match produces a file of exactly the
 * right size that is quietly corrupt. So every claim in the state file is checked, and anything
 * that cannot be checked is grounds for starting over.
 *
 * @param resumePath - the state file.
 * @param expectation - what this run knows: destination, url, size, and any server validators.
 * @returns the recorded parts, or null when nothing here can be trusted.
 */
export function readResumeState(resumePath, expectation) {
  try {
    if (!existsSync(resumePath)) return null
    const raw = readFileSync(resumePath, 'utf8')
    const document = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return null
    if (document.version !== 1) return null

    // The destination and the resource, not merely something of the same size. A different URL is
    // a different file however similar it looks.
    if (document.dest !== expectation.dest) return null
    if (document.url !== expectation.url) return null
    if (document.size !== expectation.size) return null

    // When the server identifies the version, a disagreement means the remote file changed and the
    // bytes on disk belong to the old one. A conflict is decisive; a missing validator on either
    // side only means this particular check cannot be made.
    if (expectation.etag != null && document.etag != null && document.etag !== expectation.etag) return null
    if (
      expectation.lastModified != null &&
      document.lastModified != null &&
      document.lastModified !== expectation.lastModified
    ) {
      return null
    }

    if (!Array.isArray(document.parts) || document.parts.length === 0) return null

    const parts = []
    for (const part of document.parts) {
      if (part === null || typeof part !== 'object') continue
      const start = Number(part.start)
      const end = Number(part.end)
      const done = Number(part.done)
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue
      if (start < 0 || end < start || end >= expectation.size) continue
      const length = end + 1 - start
      // A part recorded as further along than it is long would seek past its own end.
      parts.push({ start, end, done: Number.isInteger(done) ? Math.min(Math.max(done, 0), length) : 0 })
    }
    return parts.length === 0 ? null : parts
  } catch {
    // An unreadable state file is simply not a resumable transfer.
    return null
  }
}

/**
 * Write resume state atomically. Best-effort by design: losing progress must never fail a
 * transfer that is otherwise succeeding.
 * @param resumePath - the state file.
 * @param document - what to record.
 */
export function writeResumeState(resumePath, document) {
  try {
    const temporary = `${resumePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, 'utf8')
    rmSync(resumePath, { force: true })
    renameSync(temporary, resumePath)
  } catch {
    /* the transfer is the point; resume state is an optimisation */
  }
}

/**
 * Remove resume state and any half-written copy of it.
 * @param resumePath - the state file.
 */
export function clearResumeState(resumePath) {
  try {
    rmSync(resumePath, { force: true })
    rmSync(`${resumePath}.tmp`, { force: true })
  } catch {
    /* nothing to remove */
  }
}

/**
 * Download a URL using parallel ranged requests written straight into the destination.
 *
 * @param url - the resource to fetch.
 * @param destPath - absolute path to write. Parent directories are created.
 * @param options - engine tuning; see the module defaults.
 * @returns a structured result: never throws for an ordinary network failure.
 */
export async function downloadSegmented(url, destPath, options = {}) {
  const connections = Math.max(1, options.connections ?? DEFAULT_CONNECTIONS)
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const minSegmentBytes = Math.max(1, options.minSegmentBytes ?? MIN_SEGMENT_BYTES)
  const writeChunkBytes = Math.max(4096, options.writeChunkBytes ?? DEFAULT_WRITE_CHUNK_BYTES)
  const agents = options.agents ?? DEFAULT_AGENTS
  const onProgress = options.onProgress
  // When false, a stopped transfer leaves nothing at all behind: no partial file, no state. That is
  // the caller saying "I would rather have a clean folder than a resumable one", and it is honoured
  // on every path where a partial could otherwise survive.
  const keepPartial = options.keepPartial !== false
  const startedAt = Date.now()

  // A caller-supplied bound on how long to wait. Unlike the harness's tool timeout, which this
  // plugin deliberately does not declare, this is the caller saying "stop and let me come back" —
  // and because partial work is now resumable, stopping is cheap rather than wasteful.
  const waitMs = Number.isFinite(options.waitMs) && options.waitMs > 0 ? options.waitMs : null
  const controller = new AbortController()
  let timedOut = false
  const timer =
    waitMs === null
      ? null
      : setTimeout(() => {
          timedOut = true
          controller.abort()
        }, waitMs)

  let agentIndex = 0
  let concurrency = connections
  let segmentsUsed = 0

  /** A refusal we can react to, rather than a dead end. */
  const classify = (status) => {
    if (status === 403) return 'spoof' // try a different User-Agent
    if (status === 418 || status === 429) return 'throttle' // reduce concurrency
    return 'fatal'
  }

  try {
    let info = await inspect(url, agents[agentIndex])

    // Rotate the agent if the server dislikes the first one.
    for (let attempt = 0; attempt < agents.length - 1; attempt += 1) {
      const verdict = info.status >= 400 ? classify(info.status) : 'ok'
      if (verdict !== 'spoof') break
      agentIndex += 1
      info = await inspect(url, agents[agentIndex])
    }

    // The opening probe is not exempt from a server's rate limiting. A 418 or 429 here used to
    // abort the whole transfer before a single data byte was asked for, even though this engine's
    // whole story is that it adapts to exactly those two codes — the adaptive path only covered
    // range requests, so the very first request was the one place adaptation did not exist. Back
    // off, try again, and open the transfer more cautiously since the server has already said it
    // has had enough.
    for (let attempt = 0; attempt < 3 && (info.status === 418 || info.status === 429); attempt += 1) {
      concurrency = Math.max(1, Math.floor(concurrency / 2))
      await sleep(500 * (attempt + 1))
      info = await inspect(url, agents[agentIndex])
    }

    if (info.status >= 400) {
      return {
        ok: false,
        error: `HTTP ${info.status} on inspection`,
        hint:
          info.status === 403
            ? ' the server refused every User-Agent this engine offers'
            : info.status === 418 || info.status === 429
              ? ' the server is rate limiting this machine; it refused the opening request repeatedly'
              : ' the server refused the request',
        elapsedMs: Date.now() - startedAt,
      }
    }

    // A 200 to a ranged GET means the server ignored the range, so the whole body would come
    // back: a single stream is the only correct choice.
    const size = info.size
    const canSegment = info.ranges && size !== null && size >= minSegmentBytes * 2

    // Refuse to write something that is plainly not the file: an error or interstitial page
    // served under a 200 status. Neat Download Manager writes these to disk as if they were
    // the download, which is how a 5 KiB HTML page ended up looking like a 4.4 GiB ISO.
    if (await notAnArtifact(info, size, url, agents[agentIndex])) {
      return {
        ok: false,
        error: `the server returned ${info.contentType ?? 'an unexpected type'}${
          size === null ? '' : ` (${human(size)})`
        }, not the file`,
        hint: ' this is typically an error or interstitial page; try another mirror',
        elapsedMs: Date.now() - startedAt,
      }
    }

    mkdirSync(dirname(destPath), { recursive: true })

    if (!canSegment) {
      const bytes = await downloadSingleStream(url, destPath, agents[agentIndex])
      return {
        ok: true,
        bytes,
        method: 'single-stream',
        // Name which of the three reasons actually applies. Reporting "size unknown" for a file
        // whose size is known and merely too small to split sent a reader looking for the wrong
        // problem entirely — and the built-in engine reaches this path for every small file.
        reason: !info.ranges
          ? 'server does not support ranges'
          : size === null
            ? 'size unknown'
            : 'below the segmentation threshold',
        agent: agents[agentIndex],
        filename: info.filename,
        elapsedMs: Date.now() - startedAt,
      }
    }

    // ---- staging and resume ---------------------------------------------------------------
    //
    // The transfer works on `<dest>.part` and only takes the destination name once every segment
    // has proved complete. That is not tidiness, it is the difference between an honest folder and
    // a lying one: the file is preallocated to its final size, so a half-finished transfer would
    // otherwise have exactly the right name and exactly the right size while being full of holes.
    // Staging also turns the partial into a legitimate artifact to continue from, rather than junk
    // to sweep up.
    const stagedPath = stagedPathFor(destPath)
    const resumePath = resumePathFor(destPath)

    // Declared outside the try so the fallback below can still see it after the file handle
    // is closed. Set when a server turns out to ignore Range after all.
    let rangeIgnored = false

    const segmentCount = Math.max(1, Math.min(concurrency, Math.floor(size / minSegmentBytes)))
    const span = Math.ceil(size / segmentCount)

    // Adopt a previous run's segmentation when it checks out. Using the recorded parts rather than
    // recomputing them means progress survives a settings change in between: the bytes on disk
    // belong to those parts, not to whatever split this run would have chosen.
    const recorded = readResumeState(resumePath, {
      dest: destPath,
      url,
      size,
      etag: info.etag,
      lastModified: info.lastModified,
    })
    // A staged file of the full size is one this engine preallocated; anything else cannot be the
    // artifact the recorded parts describe.
    const stagedBytes = existsSync(stagedPath) ? statSync(stagedPath).size : -1

    /** Each part carries its own progress, which is what makes the queue the resume state. */
    let queue = []
    let resumedBytes = 0
    if (recorded !== null && stagedBytes === size) {
      queue = recorded
      resumedBytes = recorded.reduce((sum, part) => sum + part.done, 0)
      segmentsUsed = recorded.length
    } else {
      for (let index = 0; index < segmentCount; index += 1) {
        const start = index * span
        const end = Math.min(start + span - 1, size - 1)
        if (start <= end) queue.push({ start, end, done: 0 })
      }
      segmentsUsed = segmentCount
      // Nothing usable was found, so anything left over is stale and must not be considered again.
      if (recorded !== null || stagedBytes >= 0) clearResumeState(resumePath)
    }

    const resuming = resumedBytes > 0
    // 'r+' keeps the bytes already on disk; 'w' starts clean and discards an untrusted partial.
    const handle = await open(stagedPath, resuming ? 'r+' : 'w')

    // Preallocate the whole file before a single worker writes. This is not an optimisation
    // detail — it is the difference between a working download and an apparently hung one.
    //
    // Writing beyond EOF from 16 offsets at once makes the filesystem allocate and zero-fill the
    // gaps repeatedly, and on some volumes that collapses throughput entirely: measured on one
    // NVMe here, 16-way positioned writes into a growing file managed 5.5 MiB in 29 seconds
    // (0.2 MiB/s) while the same 16-way pattern into a preallocated file ran at 342 MiB/s. The
    // user-visible symptom is a progress bar that sits at 0% for a minute and then jumps.
    //
    // A single truncate does that work once, sequentially. Failure is tolerated: a handle or a
    // filesystem that refuses to be extended simply falls back to growing writes as before. A
    // resumed file is already the right size, and truncating it would be the one way to lose the
    // very bytes this run exists to keep.
    if (!resuming && size !== null && size > 0) {
      try {
        await handle.truncate(size)
      } catch {
        /* fall back to writing into a growing file */
      }
    }

    let lastResumeWrite = 0

    /** Record where each part stands. Throttled, always forced when a part completes. */
    const saveResume = (force = false) => {
      const stamp = Date.now()
      if (!force && stamp - lastResumeWrite < RESUME_FLUSH_MS) return
      lastResumeWrite = stamp
      writeResumeState(resumePath, {
        version: 1,
        url,
        dest: destPath,
        size,
        etag: info.etag ?? null,
        lastModified: info.lastModified ?? null,
        parts: queue.map(({ start, end, done }) => ({ start, end, done })),
        updatedAt: new Date().toISOString(),
      })
    }

    /** What to tell a caller whose transfer stopped part-way. */
    const partialInfo = () => {
      const downloaded = queue.reduce((sum, part) => sum + part.done, 0)
      return { path: stagedPath, resumePath, bytes: downloaded, total: size, remaining: size - downloaded }
    }

    /**
     * Decide what a stopped transfer leaves behind.
     *
     * A partial file is worth keeping only when it can actually be resumed: some bytes arrived, and
     * the state describing them is on disk. Anything else is an incomplete file wearing the
     * destination's name — precisely the leftover a user does not want to find in their folder —
     * so it is removed instead of being reported as a kind of progress. This is the difference
     * between "interrupted, carry on later" and "interrupted, here is some junk".
     *
     * @returns the partial description to report, or undefined when nothing was kept.
     */
    const keepOrDiscardPartial = () => {
      const partial = partialInfo()
      const resumable = keepPartial && partial.bytes > 0 && existsSync(resumePath)
      if (!resumable) {
        clearResumeState(resumePath)
        rmSync(stagedPath, { force: true })
        return undefined
      }
      saveResume(true)
      return partial
    }

    // Record the segmentation before any byte arrives, so even an immediate failure leaves
    // something a later run can pick up rather than an anonymous truncated file.
    saveResume(true)

    try {
      let received = resumedBytes
      let retries = 0
      let lastError
      let next = 0

      // A real cap on requests in flight, lowered when a server says it has had enough. The queue
      // decides which range each worker takes; this gate decides how many may be requesting at once.
      let limit = concurrency
      let inFlight = 0
      const waiters = []

      /** Wait for a free request slot. */
      const acquire = () =>
        new Promise((resolve) => {
          const take = () => {
            if (inFlight < limit) {
              inFlight += 1
              resolve()
            } else {
              waiters.push(take)
            }
          }
          take()
        })

      /** Give a slot back, waking one waiter. Named to avoid shadowing the queue cursor above. */
      const release = () => {
        inFlight -= 1
        const woken = waiters.shift()
        if (woken !== undefined) woken()
      }

      // Report the resumed baseline at once, so a panel shows 62% immediately instead of 0% and
      // a caller reading progress is never told less has been done than actually has.
      if (resuming && onProgress !== undefined) onProgress(resumedBytes, size)

      const worker = async () => {
        for (;;) {
          if (retries > maxRetries) return
          const index = next
          next += 1
          if (index >= queue.length) return
          const part = queue[index]
          const { start, end } = part
          // A part inherited as already complete costs nothing and is never requested again.
          const from = start + part.done
          if (from > end) continue

          for (let attempt = 0; ; attempt += 1) {
            let holding = false
            try {
              // One request slot per worker while the limit holds. This is what makes the throttle
              // response real: lowering `limit` on a 418/429 has to actually reduce the number of
              // requests in flight, and before this gate existed the value was read only when the
              // workers were spawned — so "halves concurrency automatically" was decoration that
              // could never do anything.
              await acquire()
              holding = true
              const response = await fetch(url, {
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'User-Agent': agents[agentIndex], Range: `bytes=${from}-${end}` },
              })

              // Accept both the standard 206 and the non-standard shape some servers use: a
              // 200 whose Content-Range still names the requested slice. Rejecting the latter
              // would fail against servers that are in fact honouring the range.
              const partial =
                response.status === 206 ||
                (response.status === 200 && response.headers.get('content-range') !== null)

              if (!partial) {
                const verdict = response.status >= 400 ? classify(response.status) : 'fatal'
                if (response.body !== null) await response.body.cancel().catch(() => {})
                if (verdict === 'spoof' && agentIndex < agents.length - 1) {
                  agentIndex += 1
                  continue
                }
                if (verdict === 'throttle' && attempt < 3) {
                  // Too many connections at once. Give some back and try this same range again in
                  // this worker: the part stays owned here, so it is neither abandoned (which used
                  // to end the worker outright and leave a hole) nor duplicated by another worker.
                  limit = Math.max(1, Math.floor(limit / 2))
                  await sleep(500 * (attempt + 1))
                  continue
                }
                // A 200 with no Content-Range means the server ignored the Range header and is
                // sending the whole body. Positioned writes are impossible, so stop and let the
                // caller fall back to a single stream rather than corrupting the file.
                if (response.status === 200) {
                  rangeIgnored = true
                  return
                }
                throw new Error(`HTTP ${response.status} on range ${start}-${end}`)
              }

              if (response.body === null) throw new Error('range response carried no body')

              let position = from

              // Coalesce whatever the socket delivers into large positioned writes. This is not a
              // micro-optimisation, it is the difference between a working download and one that
              // appears hung: a response body arrives in ~64 KiB chunks, and 16 workers each
              // issuing 64 KiB positioned writes into this same file measured 1.6 MiB in 48
              // seconds on one of this machine's NVMe volumes, while the identical pattern with
              // 1 MiB writes measured 5371 MiB in 45 seconds — same concurrency, same volume,
              // same destination size. The write size was the only variable. A user sees it as a
              // progress bar that sits near zero and then jumps.
              const buffer = Buffer.allocUnsafe(Math.min(writeChunkBytes, end + 1 - from))
              let filled = 0

              const flush = async () => {
                await handle.write(buffer, 0, filled, position)
                position += filled
                received += filled
                filled = 0
                // The queue is the resume state, so progress is recorded where it is made.
                part.done = position - start
                saveResume()
                if (onProgress !== undefined) onProgress(received, size)
              }

              for await (const chunk of bodyChunks(response.body)) {
                let offset = 0
                while (offset < chunk.length) {
                  const take = Math.min(buffer.length - filled, chunk.length - offset)
                  chunk.copy(buffer, filled, offset, offset + take)
                  filled += take
                  offset += take
                  if (filled === buffer.length) await flush()
                }
              }
              if (filled > 0) await flush()

              if (position !== end + 1) {
                throw new Error(`range ${start}-${end} stopped at ${position}`)
              }
              // A finished part is the durable unit: record it before the worker moves on.
              saveResume(true)
              return // segment done
            } catch (error) {
              // An aborted wait is not a failure and must not burn a retry: the transfer was
              // stopped on purpose, and everything written so far is kept and recorded.
              if (timedOut) return
              // Hand the slot back before backing off, so a retry does not sit on capacity it is
              // not using.
              if (holding) {
                release()
                holding = false
              }
              lastError = error
              if (attempt >= 2) {
                retries += 1
                if (retries > maxRetries) return
              }
              await sleep(300 * (attempt + 1))
            } finally {
              if (holding) release()
            }
          }
        }
      }

      const workers = []
      for (let index = 0; index < concurrency; index += 1) workers.push(worker())
      await Promise.all(workers)

      if (timedOut && queue.reduce((sum, part) => sum + part.done, 0) < size) {
        // The caller's wait ran out. What arrived stays when it can be resumed, and the state
        // describing it is flushed, so the next call continues instead of starting again. The size
        // check matters: a wait that expires in the same instant the last byte lands must not turn
        // a finished transfer into a report of unfinished work.
        return {
          ok: false,
          timedOut: true,
          error: `stopped after waiting ${waitMs}ms`,
          // Reported separately from `partial` so the amount that arrived is still known even when
          // nothing was kept — otherwise the message says "reached 0 B of 0 B", which reads as a
          // broken transfer rather than an early stop.
          bytes: queue.reduce((sum, part) => sum + part.done, 0),
          total: size,
          partial: keepOrDiscardPartial(),
          elapsedMs: Date.now() - startedAt,
        }
      }

      if (retries > maxRetries) {
        return {
          ok: false,
          error: `gave up after ${maxRetries} failed retries: ${lastError?.message ?? 'unknown error'}`,
          hint: ' the server may be throttling parallel requests; lower connections in settings',
          partial: keepOrDiscardPartial(),
          elapsedMs: Date.now() - startedAt,
        }
      }

      // Every part must actually be complete before any of this counts as a download.
      //
      // This is the check that a preallocated file makes impossible by size alone: the staged file
      // reaches its final length within the first second, so "the size is right" proves nothing at
      // all, and a worker that gave up part-way would otherwise be renamed into place as a file
      // full of holes and reported as a success — precisely the failure mode this engine exists to
      // make impossible. The queue is the record of what was really written, so ask it instead.
      const unfinished = rangeIgnored ? [] : queue.filter((part) => part.done < part.end + 1 - part.start)
      if (unfinished.length > 0) {
        const arrived = queue.reduce((sum, part) => sum + part.done, 0)
        return {
          ok: false,
          error:
            `incomplete: ${unfinished.length} of ${queue.length} segments did not finish ` +
            `(${human(arrived)} of ${human(size)} arrived)`,
          hint: ' the server may have refused or throttled some ranges',
          partial: keepOrDiscardPartial(),
          elapsedMs: Date.now() - startedAt,
        }
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
      await handle.close()
    }

    // The server advertised range support but then ignored the header. Positioned writes are
    // impossible, so redo the transfer as a single stream rather than reporting a failure.
    if (rangeIgnored) {
      clearResumeState(resumePath)
      discardPartial(stagedPath)
      const bytes = await downloadSingleStream(url, destPath, agents[agentIndex])
      return {
        ok: true,
        bytes,
        method: 'single-stream',
        reason: 'server ignored range requests',
        agent: agents[agentIndex],
        filename: info.filename,
        elapsedMs: Date.now() - startedAt,
      }
    }

    // What the workers claimed is now checked against the one thing that cannot lie: the staged
    // file's size. A short file is not a result, so it keeps its resume state and is reported.
    const landed = statSync(stagedPath).size
    if (landed !== size) {
      saveResume(true)
      return {
        ok: false,
        error: `wrote ${human(landed)} but the server declared ${human(size)}`,
        hint: ' the transfer was incomplete; the partial file and its resume state were kept',
        partial: partialInfo(),
        elapsedMs: Date.now() - startedAt,
      }
    }

    // Complete. The state goes first — if the rename were to fail there must not be a state file
    // claiming a transfer that is in fact finished. Only at this line does anything exist at
    // `destPath`, so a half-finished transfer can never be mistaken for a finished one, even
    // after a hard kill.
    clearResumeState(resumePath)
    rmSync(destPath, { force: true })
    renameSync(stagedPath, destPath)

    return {
      ok: true,
      bytes: landed,
      method: 'segmented',
      segments: segmentsUsed,
      // How much of this transfer was already on disk when the run started. A caller that reports
      // progress to a person can say "resumed" instead of silently taking credit for the bytes.
      resumedBytes,
      agent: agents[agentIndex],
      filename: info.filename,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    // An unexpected failure is still worth reporting the staged work for: whatever reached the disk
    // is resumable, and a caller who never learns that will download it all again.
    let partial
    try {
      const staged = stagedPathFor(destPath)
      const state = resumePathFor(destPath)
      // Same rule as the ordinary failure paths: a partial nobody can resume is not progress, it is
      // a stray file with the destination's name, so it is removed rather than reported.
      if (keepPartial && existsSync(staged) && existsSync(state)) {
        partial = { path: staged, resumePath: state }
      } else {
        clearResumeState(state)
        rmSync(staged, { force: true })
      }
    } catch {
      /* nothing to report */
    }
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      partial,
      elapsedMs: Date.now() - startedAt,
    }
  }
}

/**
 * Decide whether a response is not the requested file but an error or interstitial page.
 *
 * A page content type is refused outright when the caller did not ask for a document by name: a
 * mirror answering an ISO request with text/html under a 200 status has served a page, and that is
 * the failure this check exists for — it is how a 5 KiB page once ended up on disk looking like a
 * 4.4 GiB ISO.
 *
 * Text that is not a page is a different question, and the label cannot answer it. `text/plain` is
 * a Python script, a shell script, a YAML config, a diff, and it is also a mislabelled error page.
 * Refusing the type means refusing the script, which is what this engine used to do. So the opening
 * bytes are read for the one ambiguous case, and only a body that actually opens like an HTML
 * document is refused.
 *
 * The size test must also cover the unknown-size case. An earlier version required a known size
 * before checking at all, which skipped the check precisely where it mattered most — dynamic error
 * pages are exactly the responses that declare no Content-Length.
 *
 * @param info - the inspection result.
 * @param size - the declared size, or null when the server declared none.
 * @param url - the requested URL.
 * @param userAgent - the agent to reuse for the byte-level look, if one is needed.
 * @returns true when the response should be refused.
 */
async function notAnArtifact(info, size, url, userAgent) {
  if (info.contentType === null) return false
  const isPage = PAGE_TYPE.test(info.contentType)
  const isText = TEXT_LIKE_TYPE.test(info.contentType)
  if (!isPage && !isText) return false
  // The server explicitly offers this as a file download. Believe it: a `text/plain`
  // attachment really is a text file, and an error page carries no such header.
  if (info.disposition !== null) return false
  // The caller asked for a document by name, so a document is what it should get.
  if (asksForDocument(url)) return false
  // A large body is a real download rather than a stub page.
  if (size !== null && size >= 512 * 1024) return false
  // A page is never what a download wanted; anything else textual is settled by its bytes.
  return isPage ? true : await opensLikePage(url, userAgent)
}

/** Whether the URL names a document, so a document response is the expected one. */
function asksForDocument(url) {
  try {
    return DOCUMENT_PATH.test(new URL(url).pathname)
  } catch {
    // An unparseable URL is not a reason to refuse.
    return false
  }
}

/**
 * Read the opening bytes of a small text response and report whether they are the start of an HTML
 * document.
 *
 * This costs one extra kilobyte, and only in the case where the answer is genuinely ambiguous. An
 * inconclusive look returns false: refusing on a network hiccup is precisely how a legitimate
 * download gets blocked, and a caller that cares about what it received can pass a checksum.
 *
 * @returns true when the bytes say "this is a web page".
 */
async function opensLikePage(url, userAgent) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': userAgent, Range: 'bytes=0-1023' },
    })
    if (response.body === null) return false
    const reader = response.body.getReader()
    let first
    try {
      first = await reader.read()
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (first.done || first.value === undefined) return false
    const head = Buffer.from(first.value).toString('utf8').replace(/^\uFEFF/, '')
    return PAGE_HEAD.test(head)
  } catch {
    return false
  }
}

/**
 * Single-stream fallback for servers that do not support ranges.
 * @returns the byte count written.
 */
async function downloadSingleStream(url, destPath, userAgent) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': userAgent } })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  if (response.body === null) throw new Error('response carried no body')
  const temporary = `${destPath}.part`
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    rmSync(destPath, { force: true })
    renameSync(temporary, destPath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return statSync(destPath).size
}

/**
 * Remove a partially written file after a failed transfer.
 * @param destPath - the path to remove.
 */
export function discardPartial(destPath) {
  if (!existsSync(destPath)) return
  try {
    rmSync(destPath, { force: true })
  } catch {
    /* a locked file is not worth throwing over */
  }
}

export const defaults = {
  connections: DEFAULT_CONNECTIONS,
  maxRetries: DEFAULT_MAX_RETRIES,
  writeChunkBytes: DEFAULT_WRITE_CHUNK_BYTES,
  agents: DEFAULT_AGENTS,
  minSegmentBytes: MIN_SEGMENT_BYTES,
}
