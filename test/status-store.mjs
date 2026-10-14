/**
 * Tests for the download status registry — the data layer a progress UI will read.
 *
 * The point of these assertions is that a UI can trust the file: it must always be valid JSON,
 * it must distinguish a running download from a finished one, it must carry the failure reason,
 * and it must never be left half-written.
 */

// Resolved from this file's own location, so a cloned copy runs anywhere.
const ROOT_LIB = new URL('../', import.meta.url).href

import { existsSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODULE = `${ROOT_LIB}lib/status.js`
const { createStatusStore, STATE } = await import(MODULE)

const ROOT = join(tmpdir(), `dsh-status-${Date.now()}`).replace(/\\/g, '/')
mkdirSync(ROOT, { recursive: true })
const FILE = `${ROOT}/status.json`

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (detail !== undefined) console.log(`        ${String(detail).slice(0, 170)}`)
}

try {
  const store = createStatusStore({ path: FILE, flushMs: 0 })

  // 1. Starting a download publishes it as active.
  const first = store.begin({ url: 'https://example.test/a.iso', dest: 'C:/out/a.iso', engine: 'builtin', total: 1000 })
  let onDisk = JSON.parse(readFileSync(FILE, 'utf8'))
  check('a started download appears in `active`', onDisk.active.length === 1, JSON.stringify(onDisk.active[0]?.state))
  check('the entry carries a usable id', typeof first.id === 'string' && first.id.length > 8, first.id)
  check('the declared total is recorded', onDisk.active[0].total === 1000, String(onDisk.active[0].total))

  // 2. Progress is reflected with a percentage, and a speed once enough time has passed.
  store.progress(first.id, { bytes: 250 })
  store.progress(first.id, { bytes: 500 })
  await new Promise((done) => setTimeout(done, 700))
  store.progress(first.id, { bytes: 600 })
  onDisk = JSON.parse(readFileSync(FILE, 'utf8'))
  check('progress updates the byte count', onDisk.active[0].bytes === 600, String(onDisk.active[0].bytes))
  check('a percentage is derived', onDisk.active[0].percent === 60, String(onDisk.active[0].percent))
  check('a speed is derived', typeof onDisk.active[0].speedBps === 'number', `${onDisk.active[0].speedBps} B/s`)

  // 3. Completion moves the entry out of `active` and into `recent`.
  store.finish(first.id, { ok: true, bytes: 1000, method: 'segmented' })
  onDisk = JSON.parse(readFileSync(FILE, 'utf8'))
  check('a finished download leaves `active`', onDisk.active.length === 0)
  check('a finished download appears in `recent`', onDisk.recent.length === 1 && onDisk.recent[0].state === 'completed', onDisk.recent[0]?.state)
  check('the method used is recorded', onDisk.recent[0].method === 'segmented', onDisk.recent[0].method)

  // 4. A failure carries the reason and the hint, so a panel can explain rather than just go red.
  const second = store.begin({ url: 'https://example.test/b.iso', dest: 'C:/out/b.iso', engine: 'ndm', total: null })
  store.finish(second.id, { ok: false, error: 'HTTP 403 on inspection', hint: ' the server refused the request' })
  onDisk = JSON.parse(readFileSync(FILE, 'utf8'))
  const failed = onDisk.recent.find((entry) => entry.state === 'failed')
  check('a failure is recorded as failed', failed !== undefined, failed?.state)
  check('the failure reason is preserved', failed?.error === 'HTTP 403 on inspection', failed?.error)
  check('the failure hint is preserved', typeof failed?.hint === 'string', failed?.hint)
  check('an unknown total yields a null percentage rather than NaN', failed?.percent === null, String(failed?.percent))

  // 5. Cancellation is its own state, not a failure.
  const third = store.begin({ url: 'https://example.test/c.iso', dest: 'C:/out/c.iso', engine: 'ndm', total: 10 })
  store.finish(third.id, { ok: false, cancelled: true, error: 'stopped in Neat Download Manager' })
  onDisk = JSON.parse(readFileSync(FILE, 'utf8'))
  check('a cancellation is not reported as a failure', onDisk.recent.some((e) => e.state === STATE.cancelled), onDisk.recent.map((e) => e.state).join(', '))

  // 6. The document a UI reads is always well-formed, and no temporary file is left behind.
  check('the mirror file parses as JSON', typeof onDisk.version === 'number', `version ${onDisk.version}`)
  check('a timestamp is present for the UI to show freshness', typeof onDisk.updatedAt === 'string', onDisk.updatedAt)
  check('no .tmp sibling is left behind', !existsSync(`${FILE}.tmp`), readdirSync(ROOT).join(', '))

  // 7. History is bounded, so the file cannot grow without limit.
  const small = createStatusStore({ path: `${ROOT}/bounded.json`, maxHistory: 3, flushMs: 0 })
  for (let index = 0; index < 10; index += 1) {
    const entry = small.begin({ url: `https://example.test/${index}`, dest: `C:/out/${index}`, engine: 'builtin' })
    small.finish(entry.id, { ok: true })
  }
  check('history is capped', small.snapshot().recent.length === 3, `kept ${small.snapshot().recent.length}`)

  // 8. A read-only or impossible path must not throw: status is a side channel.
  let threw = false
  try {
    const broken = createStatusStore({ path: 'Z:/definitely/not/writable/status.json', flushMs: 0 })
    const entry = broken.begin({ url: 'https://example.test/d', dest: 'C:/d', engine: 'builtin' })
    broken.finish(entry.id, { ok: true })
  } catch {
    threw = true
  }
  check('an unwritable status path does not throw', !threw)

  // 9. Disabling the mirror entirely is supported (path omitted).
  let noPathThrew = false
  try {
    const off = createStatusStore({})
    const entry = off.begin({ url: 'https://example.test/e', dest: 'C:/e', engine: 'builtin' })
    off.progress(entry.id, { bytes: 5 })
    off.finish(entry.id, { ok: true })
    check('a store without a path still tracks in memory', off.snapshot().recent.length === 1)
  } catch {
    noPathThrew = true
  }
  check('a store without a path does not throw', !noPathThrew)
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
