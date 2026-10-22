/**
 * Multi-source downloads: ranges spread across mirrors, but only mirrors that prove they serve the
 * same file.
 *
 * The whole feature hinges on that proof. Splicing ranges from two different builds produces a file
 * that passes every later check — right size, every segment "complete" — while containing bytes from
 * two files. So these tests are as much about refusals as about speed:
 *
 *  1. two identical mirrors — both carry data, the file is correct
 *  2. a mirror whose bytes differ in the middle — refused, and refused *because* of the middle
 *  3. a mirror with a different size — refused before any byte is trusted to it
 *  4. a mirror that dies part-way — dropped, and the transfer still completes correctly
 *  5. no extra sources — unchanged behaviour, no `sources` field in the result
 *
 * Everything runs against local servers, so the suite costs no network and takes a few seconds.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(tmpdir(), `dsh-multisource-${process.pid}`)
mkdirSync(ROOT, { recursive: true })

const ENGINE = new URL('../lib/engine-builtin.js', import.meta.url).href
const { downloadSegmented, stagedPathFor, resumePathFor } = await import(ENGINE)

const SIZE = 8 * 1024 * 1024
const SOURCE = Buffer.alloc(SIZE)
for (let index = 0; index < SIZE; index += 1) SOURCE[index] = (index * 37 + 11) & 0xff

/** A file that differs from SOURCE in exactly one byte, in the middle third. */
const DIFFERENT_MIDDLE = Buffer.from(SOURCE)
DIFFERENT_MIDDLE[Math.floor(SIZE / 2) + 7] ^= 0xff

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `\n        ${detail}`}`)
}

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sourceHash = hash(SOURCE)

/**
 * Serve `body` with range support and count what kind of request each one was: `probe` asks for two
 * bytes, `window` for a comparison window, and `data` for anything larger — which is the only kind
 * that means a mirror was trusted with part of the file.
 */
async function serve(body, options = {}) {
  const counts = { probe: 0, window: 0, data: 0 }
  const ranges = []
  let dataServed = 0
  const server = createServer((request, response) => {
    const match = /bytes=(\d+)-(\d+)?/.exec(request.headers.range ?? '')
    if (match === null) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      response.end(body)
      return
    }
    const start = Number(match[1])
    const end = Number(match[2] ?? body.length - 1)
    const length = end - start + 1
    if (length <= 2) counts.probe += 1
    else if (length <= 64 * 1024) counts.window += 1
    else {
      counts.data += 1
      dataServed += 1
      ranges.push(`${start}-${end}`)
    }
    response.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(length),
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'accept-ranges': 'bytes',
    })
    // A mirror configured to die hands out part of one range and then drops the connection, which is
    // what a flaky mirror looks like from the client side.
    if (options.dieAfter !== undefined && dataServed > options.dieAfter) {
      response.write(body.subarray(start, start + Math.min(65536, length)), () => {
        response.socket?.destroy()
      })
      return
    }
    response.end(body.subarray(start, end + 1))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/file.bin`
  return {
    url,
    counts,
    ranges,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.()
        server.close(done)
      }),
  }
}

const dest = (name) => join(ROOT, 'out', name)
const wipe = (name) => {
  for (const suffix of ['', '.part', '.part.json']) rmSync(`${dest(name)}${suffix}`, { force: true })
}
const OPTIONS = { connections: 4, minSegmentBytes: 1024 * 1024, agents: ['curl/8.21.0'] }

try {
  // ============================================================================================
  console.log('=== 1. two identical mirrors: both are used and the file is correct ===')
  {
    const primary = await serve(SOURCE)
    const mirror = await serve(SOURCE)
    wipe('both.bin')
    const outcome = await downloadSegmented(primary.url, dest('both.bin'), {
      ...OPTIONS,
      sources: [mirror.url],
    })
    check('the transfer succeeds', outcome.ok === true, String(outcome.error ?? 'ok'))
    check(
      'the file is byte-identical to the source',
      existsSync(dest('both.bin')) && hash(readFileSync(dest('both.bin'))) === sourceHash,
    )
    check('the primary carried data ranges', primary.counts.data > 0, JSON.stringify(primary.counts))
    check('the extra mirror carried data ranges too', mirror.counts.data > 0, JSON.stringify(mirror.counts))
    check(
      'the result names both mirrors as used',
      Array.isArray(outcome.sources?.used) && outcome.sources.used.length === 2,
      JSON.stringify(outcome.sources ?? null),
    )
    check('nothing was refused in the identical case', (outcome.sources?.rejected ?? []).length === 0)
    await primary.close()
    await mirror.close()
  }

  // ============================================================================================
  console.log('')
  console.log('=== 2. a mirror whose bytes differ in the middle is refused ===')
  {
    const primary = await serve(SOURCE)
    const wrong = await serve(DIFFERENT_MIDDLE)
    wipe('wrong.bin')
    const outcome = await downloadSegmented(primary.url, dest('wrong.bin'), {
      ...OPTIONS,
      sources: [wrong.url],
    })
    check('the transfer still succeeds on the primary alone', outcome.ok === true, String(outcome.error ?? 'ok'))
    check(
      'the file is correct, so no wrong bytes were spliced in',
      existsSync(dest('wrong.bin')) && hash(readFileSync(dest('wrong.bin'))) === sourceHash,
    )
    const rejected = outcome.sources?.rejected ?? []
    check('the mismatched mirror is reported as refused', rejected.length === 1, JSON.stringify(rejected))
    check(
      'the reason names the byte comparison, not a guess about speed',
      /differ/.test(String(rejected[0]?.reason ?? '')),
      String(rejected[0]?.reason ?? 'no reason'),
    )
    check('the refused mirror was never trusted with a data range', wrong.counts.data === 0, JSON.stringify(wrong.counts))
    check('but it was probed and sampled', wrong.counts.probe > 0 && wrong.counts.window > 0, JSON.stringify(wrong.counts))
    await primary.close()
    await wrong.close()
  }

  // ============================================================================================
  console.log('')
  console.log('=== 3. a mirror with a different size is refused before any range is trusted ===')
  {
    const primary = await serve(SOURCE)
    const truncated = await serve(SOURCE.subarray(0, SIZE - 1024))
    wipe('short.bin')
    const outcome = await downloadSegmented(primary.url, dest('short.bin'), {
      ...OPTIONS,
      sources: [truncated.url],
    })
    check('the transfer still succeeds', outcome.ok === true, String(outcome.error ?? 'ok'))
    const rejected = outcome.sources?.rejected ?? []
    check('the smaller mirror is refused on size', /size/.test(String(rejected[0]?.reason ?? '')), JSON.stringify(rejected))
    check('and it never served a data range', truncated.counts.data === 0, JSON.stringify(truncated.counts))
    await primary.close()
    await truncated.close()
  }

  // ============================================================================================
  console.log('')
  console.log('=== 4. a mirror that dies part-way is dropped and the transfer completes ===')
  {
    const primary = await serve(SOURCE)
    const flaky = await serve(SOURCE, { dieAfter: 1 })
    wipe('flaky.bin')
    const outcome = await downloadSegmented(primary.url, dest('flaky.bin'), {
      ...OPTIONS,
      sources: [flaky.url],
    })
    check('the transfer still succeeds', outcome.ok === true, String(outcome.error ?? 'ok'))
    check(
      'the file is byte-identical despite the failure',
      existsSync(dest('flaky.bin')) && hash(readFileSync(dest('flaky.bin'))) === sourceHash,
    )
    check('the flaky mirror did carry at least one range', flaky.counts.data > 0, JSON.stringify(flaky.counts))
    await primary.close()
    await flaky.close()
  }

  // ============================================================================================
  console.log('')
  console.log('=== 5. without extra sources nothing changes ===')
  {
    const primary = await serve(SOURCE)
    wipe('plain.bin')
    const outcome = await downloadSegmented(primary.url, dest('plain.bin'), OPTIONS)
    check('the transfer succeeds', outcome.ok === true, String(outcome.error ?? 'ok'))
    check('no sources field is reported when none were asked for', outcome.sources === undefined, String(outcome.sources))
    check('and exactly one mirror served it', primary.counts.data > 0)
    await primary.close()
  }
} finally {
  for (const name of ['both.bin', 'wrong.bin', 'short.bin', 'flaky.bin', 'plain.bin']) {
    rmSync(dest(name), { force: true })
    rmSync(stagedPathFor(dest(name)), { force: true })
    rmSync(resumePathFor(dest(name)), { force: true })
  }
  rmSync(ROOT, { recursive: true, force: true })
  writeFileSync(join(tmpdir(), 'dsh-multisource-last-run.txt'), new Date().toISOString())
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
