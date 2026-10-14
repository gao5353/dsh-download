/**
 * Resume tests for the built-in engine.
 *
 * Resuming is the one feature where being wrong is worse than being slow: bytes already on disk
 * are spliced together with bytes about to arrive, and a bad match yields a file of exactly the
 * right size that is quietly corrupt. So this suite does not merely check that a resume happens —
 * it checks that the result is byte-identical to the source, and that every claim a resume state
 * makes is verified before any of it is believed.
 *
 * Structure:
 *   1. unit checks on the state reader — what it accepts, and every reason it refuses;
 *   2. an interrupted transfer against a server that drops the connection mid-range;
 *   3. a second run that must continue from the exact byte the first one stopped at;
 *   4. tampered and mismatched states, which must be discarded rather than trusted.
 *
 * Everything runs against a local range server over a file built in a temporary directory, so the
 * suite needs no network, no mirror's goodwill, and no gigabytes of bandwidth.
 */

// Resolved from this file's own location, so a cloned copy runs anywhere.
const ROOT_LIB = new URL('../', import.meta.url).href

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(tmpdir(), `dsh-resume-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
mkdirSync(ROOT, { recursive: true })

// Status recording is redirected: a test must never write into the history the user's panel shows.
process.env.DSH_NDM_STATUS = join(ROOT, 'status.json').replace(/\\/g, '/')

const ENGINE = `${ROOT_LIB}lib/engine-builtin.js`
const { downloadSegmented, readResumeState, stagedPathFor, resumePathFor } = await import(ENGINE)

const SIZE = 48 * 1024 * 1024
const PARTS = 8
const PART_BYTES = SIZE / PARTS // 6 MiB per part
const WRITE_CHUNK = 256 * 1024
const FAIL_BYTES = 1_500_000 // delivered before the socket is destroyed
const SOURCE = join(ROOT, 'source.bin')
const DEST = join(ROOT, 'download', 'artifact.bin')
const STAGED = stagedPathFor(DEST)
const STATE = resumePathFor(DEST)

let failures = 0
const check = (label, condition, detail) => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (detail !== undefined) console.log(`        ${detail}`)
}

const sha256 = (path) =>
  new Promise((done, fail) => {
    const digest = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => digest.update(chunk))
      .on('end', () => done(digest.digest('hex')))
      .on('error', fail)
  })

// ---- the source file: deterministic, non-repetitive, so an offset error cannot hide ----------
{
  const block = Buffer.alloc(64 * 1024)
  const output = Buffer.alloc(SIZE)
  for (let offset = 0; offset < SIZE; offset += block.length) {
    const digest = createHash('sha256').update(`block-${offset}`).digest()
    for (let index = 0; index < block.length; index += 1) block[index] = digest[index % digest.length] ^ (offset >> 16)
    block.copy(output, offset)
  }
  mkdirSync(join(ROOT, 'download'), { recursive: true })
  writeFileSync(SOURCE, output)
}

// ---- a range server that can be told to drop connections or to crawl ------------------------
let mode = 'good'
let run = 0
const requested = []
// Read once: every response slices this buffer, so the fixture never depends on disk timing.
const SOURCE_BYTES = readFileSync(SOURCE)

const server = createServer((request, response) => {
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
  if (range === null) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SIZE })
    if (request.method === 'HEAD') response.end()
    else createReadStream(SOURCE).pipe(response)
    return
  }
  const start = Number(range[1])
  const end = range[2] === '' ? SIZE - 1 : Math.min(Number(range[2]), SIZE - 1)
  requested.push({ run, start, end })
  response.writeHead(206, {
    'content-type': 'application/octet-stream',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${SIZE}`,
    'accept-ranges': 'bytes',
    etag: '"resume-fixture-v1"',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  if (mode === 'fail') {
    // Promise a full range, deliver a TRUE prefix of it, then drop the connection. Sending filler
    // instead would be a different test entirely: the engine would faithfully write the wrong
    // bytes and record them as done, which is correct behaviour for bytes it really received.
    const last = Math.min(start + FAIL_BYTES - 1, end)
    response.write(SOURCE_BYTES.subarray(start, last + 1), () => {
      try {
        response.socket?.destroy()
      } catch {
        /* already gone */
      }
    })
    return
  }
  if (mode === 'slow') {
    // A slow but honest server, so a bounded wait has something to interrupt.
    let position = start
    const tick = setInterval(() => {
      if (position > end) {
        clearInterval(tick)
        response.end()
        return
      }
      const last = Math.min(position + 64 * 1024 - 1, end)
      response.write(SOURCE_BYTES.subarray(position, last + 1))
      position = last + 1
    }, 60)
    response.on('close', () => clearInterval(tick))
    return
  }
  createReadStream(SOURCE, { start, end }).pipe(response)
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/artifact.bin`
const sourceHash = await sha256(SOURCE)
console.log(`fixture: ${SIZE / 1048576} MiB in ${PARTS} parts of ${PART_BYTES / 1048576} MiB`)
console.log('')

try {
  // ---- 1. the state reader: what it refuses, and why ----------------------------------------
  const expectation = { dest: DEST, url, size: SIZE, etag: '"v1"', lastModified: null }
  const validState = {
    version: 1,
    url,
    dest: DEST,
    size: SIZE,
    etag: '"v1"',
    lastModified: null,
    parts: [
      { start: 0, end: PART_BYTES - 1, done: 1024 },
      { start: PART_BYTES, end: 2 * PART_BYTES - 1, done: 0 },
    ],
  }
  const writeState = (path, document) => writeFileSync(path, JSON.stringify(document), 'utf8')

  const accepted = join(ROOT, 'accepted.json')
  writeState(accepted, validState)
  check('a state describing this transfer is accepted', readResumeState(accepted, expectation)?.length === 2)

  const cases = [
    ['a different destination', { ...validState, dest: 'C:/elsewhere.bin' }],
    ['a different url', { ...validState, url: 'https://example.test/other.bin' }],
    ['a different size', { ...validState, size: SIZE + 1 }],
    ['a different etag', { ...validState, etag: '"v2"' }],
    ['an unknown version', { ...validState, version: 2 }],
    ['no parts at all', { ...validState, parts: [] }],
    ['a part that overruns the file', { ...validState, parts: [{ start: 0, end: SIZE + 10, done: 1 }] }],
    ['a part ending before it starts', { ...validState, parts: [{ start: 100, end: 50, done: 1 }] }],
  ]
  for (const [label, document] of cases) {
    const path = join(ROOT, 'rejected.json')
    writeState(path, document)
    check(`${label} is refused`, readResumeState(path, expectation) === null)
  }

  const malformed = join(ROOT, 'malformed.json')
  writeFileSync(malformed, '{ this is not json', 'utf8')
  check('unparseable state is refused', readResumeState(malformed, expectation) === null)

  writeState(malformed, { ...validState, parts: [{ start: 0, end: PART_BYTES - 1, done: PART_BYTES + 999 }] })
  const clamped = readResumeState(malformed, expectation)
  check(
    'a part cannot be recorded as longer than it is',
    clamped?.[0]?.done === PART_BYTES,
    `done=${clamped?.[0]?.done} of ${PART_BYTES}`,
  )
  check('a state whose lastModified conflicts is refused', (() => {
    writeState(malformed, { ...validState, lastModified: 'yesterday' })
    return readResumeState(malformed, { ...expectation, lastModified: 'today' }) === null
  })())

  // ---- 2. an interrupted transfer keeps its work -------------------------------------------
  mode = 'fail'
  run = 1
  const first = await downloadSegmented(url, DEST, {
    connections: PARTS,
    minSegmentBytes: 1,
    writeChunkBytes: WRITE_CHUNK,
    maxRetries: 2,
  })
  check('the interrupted transfer reports failure', first.ok === false, first.error)
  check('it names the staged partial it kept', first.partial?.path === STAGED, String(first.partial?.path))
  check('nothing took the destination name', !existsSync(DEST))
  check('the staged file exists', existsSync(STAGED), `${existsSync(STAGED) ? statSync(STAGED).size : 0} bytes`)
  check('the resume state exists', existsSync(STATE))

  const recorded = readResumeState(STATE, { dest: DEST, url, size: SIZE, etag: '"resume-fixture-v1"', lastModified: null })
  check('the recorded state is usable', Array.isArray(recorded) && recorded.length > 0, `${recorded?.length} parts`)
  const recordedBytes = (recorded ?? []).reduce((sum, part) => sum + part.done, 0)
  check(
    'progress was recorded for the interrupted parts',
    recordedBytes > 0,
    `${(recordedBytes / 1048576).toFixed(2)} MiB of ${SIZE / 1048576} MiB`,
  )

  // ---- 3. the next run continues from exactly where that one stopped ------------------------
  mode = 'good'
  run = 2
  const second = await downloadSegmented(url, DEST, {
    connections: PARTS,
    minSegmentBytes: 1,
    writeChunkBytes: WRITE_CHUNK,
    maxRetries: 2,
  })
  check('the second run succeeds', second.ok === true, String(second.error ?? second.method))
  check(
    'it reports how much it inherited',
    typeof second.resumedBytes === 'number' && second.resumedBytes > 0,
    `${second.resumedBytes} bytes`,
  )

  // The decisive assertion: every request in the second run must begin at or after the byte the
  // first run had already written for that part. A resume that re-fetches from a part's start, or
  // worse from a part boundary it guesses, is exactly the bug this test exists to catch.
  //
  // Two-byte range probes are excluded: the engine asks for `bytes=0-1` to learn the size and the
  // validators before it decides anything, and that request is not a data transfer.
  const secondRunRequests = requested.filter((entry) => entry.run === 2 && entry.end - entry.start + 1 > 2)
  const partFor = (start) => (recorded ?? []).find((part) => start >= part.start && start <= part.end)
  const misaligned = secondRunRequests.filter((entry) => {
    const part = partFor(entry.start)
    if (part === undefined) return false // a part the second run had to invent; it starts at 0 progress
    return entry.start < part.start + part.done
  })
  check(
    'no request re-fetches bytes the first run already wrote',
    misaligned.length === 0,
    misaligned.length === 0 ? `${secondRunRequests.length} requests checked` : JSON.stringify(misaligned.slice(0, 3)),
  )

  const refetched = secondRunRequests.reduce((sum, entry) => sum + (entry.end - entry.start + 1), 0)
  check(
    'the second run fetches less than the whole file',
    refetched <= SIZE - recordedBytes + 4 * 1024 * 1024,
    `${(refetched / 1048576).toFixed(1)} MiB for ${(SIZE / 1048576).toFixed(0)} MiB with ` +
      `${(recordedBytes / 1048576).toFixed(1)} MiB already on disk`,
  )

  // The other decisive assertion: the spliced file is byte-identical to the source.
  check('the file landed at the destination', existsSync(DEST))
  check('it is exactly the declared size', existsSync(DEST) && statSync(DEST).size === SIZE)
  const resultHash = existsSync(DEST) ? await sha256(DEST) : '(missing)'
  check('the resumed file is byte-identical to the source', resultHash === sourceHash, resultHash.slice(0, 16) + '…')

  // ---- 4. no residue ------------------------------------------------------------------------
  check('the staged file is gone after success', !existsSync(STAGED))
  check('the resume state is gone after success', !existsSync(STATE))
  check('no .tmp sibling of the state is left', !existsSync(`${STATE}.tmp`))

  // ---- 5. a tampered state is discarded, not trusted ---------------------------------------
  rmSync(DEST, { force: true })
  writeFileSync(STAGED, Buffer.alloc(SIZE, 0x42)) // plausible-looking staged file, wrong content
  writeState(STATE, {
    version: 1,
    url,
    dest: DEST,
    size: SIZE + 4096, // a different resource
    etag: '"resume-fixture-v1"',
    parts: [{ start: 0, end: SIZE - 1, done: SIZE }], // and it claims to be finished
  })
  run = 3
  const third = await downloadSegmented(url, DEST, {
    connections: PARTS,
    minSegmentBytes: 1,
    writeChunkBytes: WRITE_CHUNK,
    maxRetries: 1,
  })
  check('a state describing a different resource is not resumed', third.resumedBytes === 0, String(third.resumedBytes))
  check('that run still produced a correct file', third.ok === true && (await sha256(DEST)) === sourceHash)
  check('and it left no residue either', !existsSync(STAGED) && !existsSync(STATE) && !existsSync(`${STATE}.tmp`))

  // ---- 6. a bounded wait stops cleanly, and the next call continues -------------------------
  // This is the flow a caller actually uses: ask for a bounded wait, be told exactly how far it
  // got, then come back. It is also the only way to interrupt a transfer without killing dsh.
  rmSync(DEST, { force: true })
  mode = 'slow'
  run = 4
  const bounded = await downloadSegmented(url, DEST, {
    connections: PARTS,
    minSegmentBytes: 1,
    writeChunkBytes: WRITE_CHUNK,
    waitMs: 700,
  })
  check('a bounded wait reports a timeout rather than a failure', bounded.timedOut === true, String(bounded.error))
  check('it is not reported as ok', bounded.ok === false)
  check('it kept the partial and its resume state', existsSync(STAGED) && existsSync(STATE))
  check('nothing took the destination name', !existsSync(DEST))
  check(
    'it reports how far it got',
    (bounded.partial?.bytes ?? 0) > 0 && (bounded.partial?.total ?? 0) === SIZE,
    `${((bounded.partial?.bytes ?? 0) / 1048576).toFixed(2)} MiB of ${SIZE / 1048576} MiB`,
  )

  mode = 'good'
  run = 5
  const finished = await downloadSegmented(url, DEST, {
    connections: PARTS,
    minSegmentBytes: 1,
    writeChunkBytes: WRITE_CHUNK,
  })
  check('the follow-up call completes the transfer', finished.ok === true, String(finished.error ?? ''))
  check(
    'and it continued rather than starting over',
    (finished.resumedBytes ?? 0) > 0,
    `${((finished.resumedBytes ?? 0) / 1048576).toFixed(2)} MiB inherited`,
  )
  check('the finished file is byte-identical to the source', existsSync(DEST) && (await sha256(DEST)) === sourceHash)
  check('no residue after that completion', !existsSync(STAGED) && !existsSync(STATE) && !existsSync(`${STATE}.tmp`))

  // ---- 7. what the caller is actually told, through the plugin ------------------------------
  // The engine's own results are one thing; the line a person or an agent reads is produced by the
  // host half. A message that names a file that does not exist is a bug you only find by reading
  // it, so the wording is asserted here (this is how `….iso.part.part` was caught).
  const HIS_HOME = join(ROOT, 'home')
  mkdirSync(HIS_HOME, { recursive: true })
  process.env.DSH_HOME = HIS_HOME.replace(/\\/g, '/')
  // A threshold this small forces the segmented path for this fixture, which is what carries the
  // resume state, without needing a gigabyte-sized source.
  writeFileSync(
    join(HIS_HOME, 'dsh-download.settings.json'),
    JSON.stringify({ engine: 'builtin', thresholdBytes: 4 * 1024 * 1024, builtinConnections: PARTS }),
    'utf8',
  )

  const plugin = await import(`${ROOT_LIB}lib/index.js`)
  let tool
  plugin.apply({
    tools: {
      register(definition) {
        tool = definition
      },
    },
    get() {
      return undefined
    },
    effect(fn) {
      return fn()
    },
  })

  const PLUGIN_DEST = join(HIS_HOME, 'bounded', 'artifact.bin')
  mode = 'slow'
  run = 6
  // Long enough that real bytes land: a stop before anything is written legitimately keeps nothing,
  // and that path is asserted separately in the integrity suite.
  const message = String(await tool.execute({ url, dest: PLUGIN_DEST, waitSeconds: 3 }))
  console.log(`    message: ${message}`)
  check('the plugin reports a bounded wait as TIMEOUT', message.startsWith('TIMEOUT'), message)
  check('it does not call the wait a failure', !message.startsWith('FAIL'))
  check('the staged path is named once, not twice', !message.includes('.part.part'), message)
  // The rule, rather than the wording: whatever path the message names must be a file that exists.
  // This is what caught `….iso.part.part` — a message naming something nobody could ever find.
  const named = /kept at ([^;]+);/.exec(message)
  if (named !== null) {
    check('the staged file it names really exists', existsSync(named[1].trim()), named[1].trim())
    check('it says how to continue', /call download_file again/.test(message), message)
  } else {
    check(
      'saying nothing was kept must be true',
      /Nothing was kept/.test(message) && !existsSync(`${PLUGIN_DEST}.part`),
      message,
    )
  }
} finally {
  server.closeAllConnections?.()
  await new Promise((done) => server.close(done))
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
