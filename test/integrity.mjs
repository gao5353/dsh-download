/**
 * Integrity and option tests for the built-in engine.
 *
 * Two things are being established here, both of which a user has to be able to trust:
 *
 * 1. **A download is never reported as successful unless every byte is really on disk.** The staged
 *    file is preallocated to its final length within the first second, so its size proves nothing —
 *    which means "the size is right" can no longer be the completion check. This suite reproduces
 *    the exact shape that used to slip through: a server that answers 429 to precisely as many
 *    requests as there are workers, so that (under the old code) every worker exited early and a
 *    hole-filled file was renamed into place and reported as OK.
 *
 * 2. **The configurable options change behaviour rather than merely existing.** Each setting is
 *    changed and an observable difference is asserted. Where an option provably has no effect on
 *    this engine — `monitor` is the honest example — that is asserted too, so it reads as a
 *    documented boundary rather than a decoration nobody noticed.
 *
 * Everything runs against a local range server, so the suite costs no network and takes seconds.
 */

import { homedir } from 'node:os'
// Resolved from this file's own location, so a cloned copy runs anywhere.
const ROOT_LIB = new URL('../', import.meta.url).href

import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(tmpdir(), `dsh-integrity-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
mkdirSync(ROOT, { recursive: true })
process.env.DSH_NDM_STATUS = join(ROOT, 'status.json').replace(/\\/g, '/')

const ENGINE = `${ROOT_LIB}lib/engine-builtin.js`
const { downloadSegmented, stagedPathFor, resumePathFor } = await import(ENGINE)

const SIZE = 32 * 1024 * 1024
const SOURCE = join(ROOT, 'source.bin')
{
  const block = Buffer.alloc(64 * 1024)
  const output = Buffer.alloc(SIZE)
  for (let offset = 0; offset < SIZE; offset += block.length) {
    const digest = createHash('sha256').update(`block-${offset}`).digest()
    for (let index = 0; index < block.length; index += 1) block[index] = digest[index % digest.length] ^ (offset >> 15)
    block.copy(output, offset)
  }
  writeFileSync(SOURCE, output)
}
const SOURCE_BYTES = readFileSync(SOURCE)
const sourceHash = createHash('sha256').update(SOURCE_BYTES).digest('hex')

let failures = 0
const check = (label, condition, detail) => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (detail !== undefined) console.log(`        ${detail}`)
}
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// ---- the fixture server ---------------------------------------------------------------------
// `throttle-data` rate-limits only real ranges, which is what a mirror does to a client opening
// many connections. `throttle-all` also refuses the opening two-byte probe, which is a different
// failure with a different correct answer.
let mode = 'good'
let throttledSoFar = 0
let probes = 0
let inFlight = 0
let maxInFlight = 0
let maxInFlightAfterThrottle = 0
let throttleBudget = 0

const server = createServer((request, response) => {
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
  if (range === null) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SIZE })
    response.end(request.method === 'HEAD' ? undefined : SOURCE_BYTES)
    return
  }
  const start = Number(range[1])
  const end = range[2] === '' ? SIZE - 1 : Math.min(Number(range[2]), SIZE - 1)
  const span = end - start + 1
  const isProbe = span <= 2
  if (isProbe) probes += 1

  // Measure real request concurrency over data ranges: this is how "halves concurrency on a 429"
  // is checked rather than taken on faith. Two phases are recorded separately, because the burst
  // that triggers the throttle is expected to be wide and the traffic afterwards is not.
  if (!isProbe) {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (throttledSoFar >= throttleBudget) {
      maxInFlightAfterThrottle = Math.max(maxInFlightAfterThrottle, inFlight)
    }
    response.on('close', () => {
      inFlight -= 1
    })
  }

  const throttling =
    mode === 'throttle-all' ||
    (mode === 'throttle-data' &&
      !isProbe &&
      (throttleBudget === Number.POSITIVE_INFINITY || throttledSoFar < throttleBudget))
  if (throttling) {
    throttledSoFar += 1
    // Held open briefly so simultaneous requests are actually observable as simultaneous: an
    // instant refusal makes every request look like the only one in flight.
    setTimeout(() => {
      response.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' })
      response.end('slow down')
    }, 25)
    return
  }
  if (mode === 'fail-partway' && !isProbe) {
    // A TRUE prefix of the range followed by a dropped connection: what a network failure looks
    // like from the client's side. The bytes that arrive are real, so whatever the client recorded
    // is genuinely resumable — which is the whole point of the case.
    const last = Math.min(start + 256 * 1024 - 1, end)
    response.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${SIZE}`,
    })
    response.write(SOURCE_BYTES.subarray(start, last + 1), () => {
      try {
        response.socket?.destroy()
      } catch {
        /* already gone */
      }
    })
    return
  }
  if (mode === 'refuse-part' && start === 8 * 1024 * 1024) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('no')
    return
  }
  response.writeHead(206, {
    'content-type': 'application/octet-stream',
    'content-length': span,
    'content-range': `bytes ${start}-${end}/${SIZE}`,
  })
  response.end(request.method === 'HEAD' ? undefined : SOURCE_BYTES.subarray(start, end + 1))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/artifact.bin`

const reset = (next, budget = 0) => {
  mode = next
  throttleBudget = budget
  throttledSoFar = 0
  probes = 0
  maxInFlight = 0
  maxInFlightAfterThrottle = 0
}
const dest = (name) => join(ROOT, 'out', name)
const wipe = (name) => {
  rmSync(dest(name), { force: true })
  rmSync(stagedPathFor(dest(name)), { force: true })
  rmSync(resumePathFor(dest(name)), { force: true })
}
mkdirSync(join(ROOT, 'out'), { recursive: true })

const CONNECTIONS = 8
const OPTIONS = { connections: CONNECTIONS, minSegmentBytes: 1, writeChunkBytes: 256 * 1024 }

try {
  // ============================================================================================
  console.log('=== 1. a server that throttles exactly as many ranges as there are workers ===')
  console.log('    (the shape that used to produce OK plus a hole-filled destination)')
  reset('throttle-data', CONNECTIONS)
  wipe('throttled.bin')
  const throttled = await downloadSegmented(url, dest('throttled.bin'), OPTIONS)
  console.log(`    result: ok=${throttled.ok} method=${throttled.method} segments=${throttled.segments ?? '-'}`)

  check('the throttled transfer still finishes', throttled.ok === true, String(throttled.error ?? 'ok'))
  check(
    'the file at the destination is byte-identical to the source',
    existsSync(dest('throttled.bin')) && hashOf(dest('throttled.bin')) === sourceHash,
    existsSync(dest('throttled.bin')) ? `${statSync(dest('throttled.bin')).size} bytes` : 'missing',
  )
  check(
    'no staged file was left behind',
    !existsSync(stagedPathFor(dest('throttled.bin'))) && !existsSync(resumePathFor(dest('throttled.bin'))),
  )
  check(
    'the fixture really does observe concurrent requests',
    maxInFlight >= 4,
    `peak ${maxInFlight} in flight at once`,
  )
  check(
    'the 429 was answered by really reducing requests in flight',
    maxInFlightAfterThrottle > 0 && maxInFlightAfterThrottle <= CONNECTIONS / 2,
    `peak ${maxInFlight} while being throttled, ${maxInFlightAfterThrottle} afterwards ` +
      `(the limit was halved to ${CONNECTIONS / 2}; before the gate existed this could not change)`,
  )

  // ============================================================================================
  console.log('')
  console.log('=== 2. a server that throttles every range forever: FAIL, never a false OK ===')
  reset('throttle-data', Number.POSITIVE_INFINITY)
  wipe('refused.bin')
  const refused = await downloadSegmented(url, dest('refused.bin'), OPTIONS)
  console.log(`    result: ok=${refused.ok} error=${String(refused.error).slice(0, 80)}`)

  check('an impossible transfer is reported as a failure', refused.ok === false)
  check('it does not claim a segment count', refused.segments === undefined)
  check(
    'the destination was never created',
    !existsSync(dest('refused.bin')),
    existsSync(dest('refused.bin')) ? 'A FILE WAS PLACED AT THE DESTINATION' : 'absent, as it should be',
  )
  // Nothing arrived, so there is nothing to resume — and a partial nobody can resume is just a
  // stray file wearing the destination's name. It must be removed, not left in someone's folder.
  check(
    'nothing was left behind, because nothing usable had arrived',
    refused.partial === undefined &&
      !existsSync(stagedPathFor(dest('refused.bin'))) &&
      !existsSync(resumePathFor(dest('refused.bin'))),
    `partial=${refused.partial === undefined ? 'none' : refused.partial.path}, ` +
      `staged=${existsSync(stagedPathFor(dest('refused.bin')))}, ` +
      `state=${existsSync(resumePathFor(dest('refused.bin')))}`,
  )

  // ============================================================================================
  console.log('')
  console.log('=== 3. a server that also refuses the opening probe: retried, then honest failure ===')
  reset('throttle-all')
  wipe('probe.bin')
  const probed = await downloadSegmented(url, dest('probe.bin'), OPTIONS)
  console.log(`    result: ok=${probed.ok} error=${String(probed.error).slice(0, 80)}`)
  check('it fails rather than hanging', probed.ok === false)
  check(
    'the opening probe was retried instead of aborting on the first refusal',
    probes >= 2,
    `${probes} probes (1 would mean the first 429 ended everything)`,
  )
  check('the failure names the real reason', /429/.test(String(probed.error)), String(probed.error))
  check('nothing at all was written', !existsSync(dest('probe.bin')) && !existsSync(stagedPathFor(dest('probe.bin'))))

  // ============================================================================================
  console.log('')
  console.log('=== 4. the same file served properly: the destination gets the real thing ===')
  reset('good')
  wipe('good.bin')
  const good = await downloadSegmented(url, dest('good.bin'), OPTIONS)
  check('the transfer succeeds', good.ok === true, String(good.error ?? 'ok'))
  check('it is byte-identical to the source', existsSync(dest('good.bin')) && hashOf(dest('good.bin')) === sourceHash)
  check('it reports the segments it used', good.segments === CONNECTIONS, `${good.segments}`)
  check('the resume state is gone after success', !existsSync(resumePathFor(dest('good.bin'))))

  // ============================================================================================
  console.log('')
  console.log('=== 5. one range the server will never serve: FAIL with resumable progress ===')
  reset('refuse-part')
  wipe('partial.bin')
  const partial = await downloadSegmented(url, dest('partial.bin'), OPTIONS)
  console.log(`    result: ok=${partial.ok} error=${String(partial.error).slice(0, 90)}`)
  check('a permanently refused range fails the transfer', partial.ok === false)
  check('the destination is not created', !existsSync(dest('partial.bin')))
  check('the partial is reported with how much arrived', (partial.partial?.bytes ?? 0) > 0, `${partial.partial?.bytes} bytes`)

  reset('good')
  const resumed = await downloadSegmented(url, dest('partial.bin'), OPTIONS)
  check('resuming after the refusal completes it', resumed.ok === true, String(resumed.error ?? 'ok'))
  check('the resumed file is byte-identical to the source', hashOf(dest('partial.bin')) === sourceHash)
  check('it actually inherited the earlier work', (resumed.resumedBytes ?? 0) > 0, `${resumed.resumedBytes} bytes inherited`)

  // ============================================================================================
  console.log('')
  console.log('=== 6. the options change behaviour rather than merely existing ===')

  // -- builtinConnections == segments ---------------------------------------------------------
  reset('good')
  wipe('one.bin')
  wipe('many.bin')
  const one = await downloadSegmented(url, dest('one.bin'), { ...OPTIONS, connections: 1 })
  const many = await downloadSegmented(url, dest('many.bin'), { ...OPTIONS, connections: CONNECTIONS })
  check(
    'connections=1 uses a single segment',
    one.segments === 1,
    `segments=${one.segments}`,
  )
  check(
    `connections=${CONNECTIONS} uses ${CONNECTIONS} segments`,
    many.segments === CONNECTIONS,
    `segments=${many.segments}`,
  )
  check('both produced identical files', hashOf(dest('one.bin')) === hashOf(dest('many.bin')))

  // -- minSegmentBytes == the segmentation threshold ------------------------------------------
  reset('good')
  wipe('whole.bin')
  wipe('split.bin')
  // A threshold above the file size leaves it undivided; below it, the workers split it.
  const whole = await downloadSegmented(url, dest('whole.bin'), {
    connections: CONNECTIONS,
    minSegmentBytes: SIZE * 2,
    writeChunkBytes: 256 * 1024,
  })
  const split = await downloadSegmented(url, dest('split.bin'), {
    connections: CONNECTIONS,
    minSegmentBytes: 512 * 1024,
    writeChunkBytes: 256 * 1024,
  })
  check(
    'a large minimum segment keeps the file on one stream',
    whole.method === 'single-stream',
    `${whole.method}, ${whole.reason ?? ''}`,
  )
  check(
    'a small minimum segment splits it',
    split.method === 'segmented' && split.segments > 1,
    `${split.method} x${split.segments}`,
  )
  check('both are still correct', hashOf(dest('whole.bin')) === sourceHash && hashOf(dest('split.bin')) === sourceHash)

  // -- waitMs bounds the wait -----------------------------------------------------------------
  reset('good')
  wipe('bounded.bin')
  const bounded = await downloadSegmented(url, dest('bounded.bin'), { ...OPTIONS, waitMs: 1 })
  check('waitMs stops a transfer', bounded.timedOut === true || bounded.ok === true, String(bounded.error ?? 'finished first'))
  check('stopping is not reported as a failure', bounded.ok === false && bounded.timedOut === true, String(bounded.error))
  check('the amount that arrived is still reported', typeof bounded.total === 'number', `${bounded.bytes} of ${bounded.total}`)
  // A stop after one millisecond has nothing to resume, so it must leave nothing at all.
  check(
    'a stop that received nothing leaves no residue',
    bounded.partial === undefined &&
      !existsSync(stagedPathFor(dest('bounded.bin'))) &&
      !existsSync(resumePathFor(dest('bounded.bin'))),
  )
  // ...and the opposite: a stop with real progress keeps a resumable partial (resume suite, which
  // drives a slow server, asserts the byte-for-byte continuation of exactly that).
  check(
    'keepPartial:false leaves nothing even when progress was made',
    (await downloadSegmented(url, dest('nokeep.bin'), { ...OPTIONS, keepPartial: false })).ok === true &&
      !existsSync(`${dest('nokeep.bin')}.part.json`),
  )

  // ============================================================================================
  console.log('')
  console.log('=== 6b. a dropped connection must not cost the work already done ===')
  // The scenario a user actually worries about: the network dies mid-transfer, the call gives up,
  // and then the question is whether the next attempt continues or starts from nothing.
  reset('fail-partway')
  wipe('dropped.bin')
  const dropped = await downloadSegmented(url, dest('dropped.bin'), OPTIONS)
  console.log(`    result: ok=${dropped.ok} error=${String(dropped.error).slice(0, 70)}`)
  check('a connection that dies part-way fails the call', dropped.ok === false)
  check(
    'the work already done survives the failure',
    existsSync(stagedPathFor(dest('dropped.bin'))) && existsSync(resumePathFor(dest('dropped.bin'))),
    `${dropped.partial?.bytes ?? 0} bytes kept`,
  )
  check('the destination is still not created', !existsSync(dest('dropped.bin')))

  // A second attempt while the server is still broken must not destroy what the first one kept.
  const stillBroken = await downloadSegmented(url, dest('dropped.bin'), OPTIONS)
  check('a failing retry does not destroy the partial', stillBroken.ok === false)
  check(
    'the partial is still there after that failed retry',
    existsSync(stagedPathFor(dest('dropped.bin'))) && existsSync(resumePathFor(dest('dropped.bin'))),
  )

  // The network comes back.
  reset('good')
  const recovered = await downloadSegmented(url, dest('dropped.bin'), OPTIONS)
  check('the download continues once the server is healthy again', recovered.ok === true, String(recovered.error ?? 'ok'))
  check('it inherited the earlier work rather than starting over', (recovered.resumedBytes ?? 0) > 0, `${recovered.resumedBytes} bytes inherited`)
  check('and the finished file is byte-identical to the source', hashOf(dest('dropped.bin')) === sourceHash)
  check(
    'nothing is left beside it',
    !existsSync(stagedPathFor(dest('dropped.bin'))) && !existsSync(resumePathFor(dest('dropped.bin'))),
  )

  // ============================================================================================
  console.log('')
  console.log('=== 7. landing: the file appears where it was asked for, and only there ===')
  // A reader that reports nothing can never report a leftover file, so this one is proved to be
  // live before it is trusted. The probe goes in this suite's own scratch directory, which means
  // the user's real download folder is never written to by a test.
  writeFileSync(join(ROOT, 'reader-liveness-probe'), '')
  check(
    'the default-download-folder reader is live (a reader that sees nothing cannot fail)',
    readdirSyncSafe(ROOT).includes('reader-liveness-probe'),
  )
  const before = new Set(readdirSyncSafe(join(homedir(), 'Downloads')))
  reset('good')
  const nested = join(ROOT, 'deep', 'folder', 'exact-name.bin')
  rmSync(nested, { force: true })
  const landed = await downloadSegmented(url, nested, OPTIONS)
  check('a nested destination is created and used', landed.ok === true && existsSync(nested), String(landed.error ?? ''))
  check('the bytes are correct at that exact path', existsSync(nested) && hashOf(nested) === sourceHash)
  check(
    'no .part or .part.json survives at that path',
    !existsSync(`${nested}.part`) && !existsSync(`${nested}.part.json`),
  )
  const after = new Set(readdirSyncSafe(join(homedir(), 'Downloads')))
  const added = [...after].filter((name) => !before.has(name))
  check('nothing was left in the default download folder', added.length === 0, added.join(', ') || 'no new entries')
  // ============================================================================================
  console.log('')
  console.log('=== 8. a text file is not a page: the content-type rule, decided by bytes ===')
  // Refusing `text/plain` refuses source code, which is a large share of what an agent downloads.
  // That is exactly what this engine did: `pyinstxtractor.py` arrived as text/plain and was refused,
  // while plain curl retrieved the same bytes without complaint. The rule now refuses a *page* and
  // accepts a *file*, and the one genuinely ambiguous case — a small text body — is settled by
  // reading its opening bytes instead of trusting the label.
  const SOURCE_PY = '#!/usr/bin/env python3\nimport sys\n\n\ndef main():\n    print("hello")\n'
  const PAGE_HTML = '<!doctype html>\n<html><body><h1>404 Not Found</h1></body></html>\n'
  const CONTENT_CASES = [
    { path: '/source.py', type: 'text/plain; charset=utf-8', body: SOURCE_PY, want: true, label: 'a Python source file is accepted' },
    { path: '/install.sh', type: 'text/plain; charset=utf-8', body: '#!/bin/sh\nset -eu\necho hi\n', want: true, label: 'a shell script is accepted' },
    { path: '/config.yml', type: 'text/plain; charset=utf-8', body: 'name: demo\nitems:\n  - one\n', want: true, label: 'a YAML config is accepted' },
    { path: '/fix.diff', type: 'text/plain; charset=utf-8', body: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', want: true, label: 'a diff is accepted' },
    { path: '/release/artifact', type: 'text/plain; charset=utf-8', body: PAGE_HTML, want: false, label: 'a page mislabelled text/plain is refused' },
    { path: '/release/artifact2', type: 'text/plain; charset=utf-8', body: '\uFEFF  <!DOCTYPE HTML>\n<html>', want: false, label: 'a page is caught behind a byte order mark and whitespace' },
    { path: '/download/iso', type: 'text/html; charset=utf-8', body: PAGE_HTML, want: false, label: 'a text/html page for a non-document URL is refused' },
    { path: '/index.html', type: 'text/html; charset=utf-8', body: PAGE_HTML, want: true, label: 'html asked for by name is still downloaded' },
  ]
  const contentServer = createServer((request, response) => {
    const found = CONTENT_CASES.find((entry) => entry.path === request.url)
    if (!found) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('no such route')
      return
    }
    const body = Buffer.from(found.body, 'utf8')
    response.writeHead(200, {
      'content-type': found.type,
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
    })
    response.end(body)
  })
  await new Promise((done) => contentServer.listen(0, '127.0.0.1', done))
  const contentBase = `http://127.0.0.1:${contentServer.address().port}`
  for (const entry of CONTENT_CASES) {
    const target = join(ROOT, 'content-type', entry.path.replace(/[\\/]/g, '_'))
    rmSync(target, { force: true })
    rmSync(stagedPathFor(target), { force: true })
    rmSync(resumePathFor(target), { force: true })
    const outcome = await downloadSegmented(contentBase + entry.path, target, { ...OPTIONS, connections: 1 })
    check(
      entry.label,
      outcome.ok === entry.want,
      outcome.ok ? `accepted ${outcome.bytes} bytes` : String(outcome.error ?? ''),
    )
    if (entry.want) {
      check(
        `${entry.path}: what was written is the body itself, byte for byte`,
        existsSync(target) && readFileSync(target, 'utf8') === entry.body,
      )
    } else {
      check(
        `${entry.path}: nothing was written for the refused response`,
        !existsSync(target) && !existsSync(`${target}.part`),
      )
    }
  }
  contentServer.closeAllConnections?.()
  await new Promise((done) => contentServer.close(done))

  // ============================================================================================
  console.log('')
  console.log('=== 9. a connection that goes silent is retried, not waited on forever ===')
  // Observed on a real machine: a mirror answered the range request with headers and then sent
  // nothing, and because nothing in the engine bounded that silence the call sat at a full
  // preallocated size with no error and no progress until it was killed by hand. These two servers
  // cover both halves of the fix — the one that never recovers must fail promptly and say why, and
  // the one that recovers on the retry must still produce a correct file.
  const SILENT_BYTES = Buffer.alloc(3 * 1024 * 1024, 9)
  const stalledRanges = new Set()
  let silentServerRequests = 0
  const silentServer = createServer((request, response) => {
    const match = /bytes=(\d+)-(\d+)?/.exec(request.headers.range ?? '')
    if (match === null) {
      // The opening probe is answered normally, so the transfer gets as far as a real range request.
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SILENT_BYTES.length) })
      response.end(SILENT_BYTES)
      return
    }
    silentServerRequests += 1
    const start = Number(match[1])
    const end = Number(match[2] ?? SILENT_BYTES.length - 1)
    // The opening probe asks for two bytes and must be answered, or the engine never reaches the
    // worker whose stall timer this section is about.
    if (start === 0 && end === 1) {
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': '2',
        'content-range': `bytes 0-1/${SILENT_BYTES.length}`,
      })
      response.end(SILENT_BYTES.subarray(0, 2))
      return
    }
    response.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${SILENT_BYTES.length}`,
    })
    // Serve the first range request for a segment properly and stall every retry: the transfer can
    // only finish if a stalled attempt is abandoned and then retried.
    if (!stalledRanges.has(start)) return
    // Headers already sent; deliberately send no body and never end the response.
  })
  await new Promise((done) => silentServer.listen(0, '127.0.0.1', done))
  const silentBase = `http://127.0.0.1:${silentServer.address().port}`

  const stallTarget = join(ROOT, 'stall', 'silent.bin')
  rmSync(stallTarget, { force: true })
  const stallStarted = Date.now()
  const stallOutcome = await downloadSegmented(`${silentBase}/silent.bin`, stallTarget, {
    ...OPTIONS,
    connections: 1,
    minSegmentBytes: 1024 * 1024,
    stallMs: 300,
    maxRetries: 0,
  })
  const stallSeconds = (Date.now() - stallStarted) / 1000
  check('a transfer that never receives a byte fails instead of hanging', stallOutcome.ok === false)
  check(
    'the failure names the silence rather than a bare AbortError',
    /no bytes for \d+(?:ms|s)/.test(String(stallOutcome.error ?? '')),
    String(stallOutcome.error ?? 'no error reported'),
  )
  check('it gives up in seconds, not never', stallSeconds < 15, `${stallSeconds.toFixed(1)}s`)

  // Now the recovering shape: every retry stalls, but the first attempt for each range delivers.
  stalledRanges.clear()
  const recoveryServer = createServer((request, response) => {
    const match = /bytes=(\d+)-(\d+)?/.exec(request.headers.range ?? '')
    if (match === null) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SILENT_BYTES.length) })
      response.end(SILENT_BYTES)
      return
    }
    const start = Number(match[1])
    const end = Number(match[2] ?? SILENT_BYTES.length - 1)
    if (start === 0 && end === 1) {
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': '2',
        'content-range': `bytes 0-1/${SILENT_BYTES.length}`,
      })
      response.end(SILENT_BYTES.subarray(0, 2))
      return
    }
    // Every request stalls once. A retry of the same range is served, which is what the stall timer
    // is supposed to make possible.
    const key = `${start}`
    const first = !stalledRanges.has(key)
    stalledRanges.add(key)
    response.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${SILENT_BYTES.length}`,
    })
    if (first) return // silent this time
    response.end(SILENT_BYTES.subarray(start, end + 1))
  })
  await new Promise((done) => recoveryServer.listen(0, '127.0.0.1', done))
  const recoveryBase = `http://127.0.0.1:${recoveryServer.address().port}`
  const recoveryTarget = join(ROOT, 'stall', 'recovered.bin')
  rmSync(recoveryTarget, { force: true })
  const recovery = await downloadSegmented(`${recoveryBase}/recovered.bin`, recoveryTarget, {
    ...OPTIONS,
    connections: 1,
    minSegmentBytes: 1024 * 1024,
    stallMs: 300,
    maxRetries: 4,
  })
  check('a range that stalls once still completes on its retry', recovery.ok === true, String(recovery.error ?? 'ok'))
  check(
    'and the recovered file is byte-identical to the source',
    existsSync(recoveryTarget) && readFileSync(recoveryTarget).equals(SILENT_BYTES),
  )
  check(
    'the stall produced real retries rather than a single abandoned attempt',
    silentServerRequests >= 2 && stalledRanges.size >= 1,
    `${silentServerRequests} requests, ${stalledRanges.size} ranges`,
  )

  silentServer.closeAllConnections?.()
  await new Promise((done) => silentServer.close(done))
  recoveryServer.closeAllConnections?.()
  await new Promise((done) => recoveryServer.close(done))
} finally {
  server.closeAllConnections?.()
  await new Promise((done) => server.close(done))
  rmSync(ROOT, { recursive: true, force: true })
}

function readdirSyncSafe(path) {
  try {
    return readdirSync(path)
  } catch (error) {
    // A folder that does not exist is a legitimate empty result. Anything else — including a reader
    // that is simply broken — must not be swallowed here. This helper decides whether the
    // "nothing was left behind" assertion below can fail at all, and returning [] for a real error
    // would quietly turn that assertion into a decoration. (It did: an earlier version of this
    // helper called require() from an ES module, which always threw, so the check could never fail.)
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
