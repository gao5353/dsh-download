/**
 * Leftover tests: nothing this plugin creates should survive its welcome.
 *
 * The complaint this exists for is concrete 鈥?a folder that contained a finished download also
 * contained a `.part` file from some other attempt, and there is no way for a person to know which
 * of the two is safe to delete. The rule now is that a partial is kept only while it can actually
 * be resumed, and that a pair too old to matter is swept on the next start.
 *
 * Fixtures are built in a temporary directory, and every assertion is about a specific path this
 * plugin wrote 鈥?never about a folder's contents in general, because a folder is the user's.
 */

// Resolved from this file's own location, so a cloned copy runs anywhere.
const ROOT_LIB = new URL('../', import.meta.url).href

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(tmpdir(), `dsh-cleanup-${Date.now()}-${Math.floor(Math.random() * 1000)}`)
// A throwaway dsh home: the sweep reads the status registry, so the registry must be ours.
process.env.DSH_HOME = ROOT.replace(/\\/g, '/')
process.env.DSH_NDM_STATUS = join(ROOT, 'dsh-download.status.json').replace(/\\/g, '/')
process.env.DSH_NDM_SETTINGS = join(ROOT, 'dsh-download.settings.json').replace(/\\/g, '/')
delete process.env.DSH_NDM_PARTIAL_DAYS

mkdirSync(ROOT, { recursive: true })

let failures = 0
const check = (label, condition, detail) => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (detail !== undefined) console.log(`        ${detail}`)
}

/** One recorded transfer plus the files an interrupted run would have left for it. */
function fixture(name, { staged = true, state = true, ageDays = 0, entry = {} } = {}) {
  const dest = join(ROOT, 'downloads', `${name}.bin`)
  const document = {
    version: 1,
    updatedAt: new Date().toISOString(),
    active: [],
    recent: [
      {
        id: name,
        url: `https://example.test/${name}.bin`,
        dest,
        engine: 'built-in',
        state: 'interrupted',
        bytes: 1024,
        total: 4096,
        percent: 25,
        speedBps: null,
        method: null,
        connections: 16,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: null,
        hint: null,
        ...entry,
      },
    ],
  }
  writeFileSync(process.env.DSH_NDM_STATUS, JSON.stringify(document), 'utf8')
  if (staged) {
    mkdirSync(join(ROOT, 'downloads'), { recursive: true })
    writeFileSync(`${dest}.part`, Buffer.alloc(4096))
  }
  if (state) writeFileSync(`${dest}.part.json`, '{"version":1}')
  const when = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000
  for (const path of [`${dest}.part`, `${dest}.part.json`]) {
    if (existsSync(path)) utimesSync(path, when, when)
  }
  return dest
}

/** Re-import the plugin so its startup sweep runs against the fixture just written. */
async function startPlugin() {
  const module = await import(
    `${ROOT_LIB}lib/index.js?t=${Date.now()}-${Math.random()}`
  )
  module.apply({
    tools: { register() {} },
    get() {
      return undefined
    },
    effect(fn) {
      return fn()
    },
  })
}

try {
  console.log('=== a partial nobody can resume is removed, however new it is ===')
  let dest = fixture('orphan-stage', { staged: true, state: false })
  await startPlugin()
  check('a partial with no state file is gone', !existsSync(`${dest}.part`), `${dest}.part`)

  dest = fixture('orphan-state', { staged: false, state: true })
  await startPlugin()
  check('a state file with no partial is gone', !existsSync(`${dest}.part.json`), `${dest}.part.json`)

  console.log('')
  console.log('=== a resumable pair is kept while it is fresh ===')
  dest = fixture('fresh-pair', { ageDays: 0 })
  await startPlugin()
  check('today\'s partial survives a restart', existsSync(`${dest}.part`))
  check('and so does its state', existsSync(`${dest}.part.json`))

  console.log('')
  console.log('=== a pair past the retention window is swept ===')
  dest = fixture('stale-pair', { ageDays: 30 })
  await startPlugin()
  check('a 30-day-old partial is gone', !existsSync(`${dest}.part`))
  check('and its state went with it', !existsSync(`${dest}.part.json`))

  console.log('')
  console.log('=== a transfer killed by a restart keeps a fresh, resumable partial ===')
  // The real shape of the case a user cares about: the previous process was killed mid-transfer, so
  // the mirror file still calls it `active`. Starting up re-records it as interrupted, and the pair
  // it left must survive that 鈥?this is precisely what makes a resume possible afterwards. (An
  // entry cannot be "in flight" during a startup sweep for the same reason: nothing is running yet.)
  dest = fixture('restart-killed', { ageDays: 0 })
  const activeDocument = JSON.parse(readFileSync(process.env.DSH_NDM_STATUS, 'utf8'))
  const killed = activeDocument.recent[0]
  writeFileSync(
    process.env.DSH_NDM_STATUS,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), active: [killed], recent: [] }),
    'utf8',
  )
  await startPlugin()
  check('the partial survives the restart that killed it', existsSync(`${dest}.part`), `${dest}.part`)
  check('and its resume state survives too', existsSync(`${dest}.part.json`))

  console.log('')
  console.log('=== retention of zero means never keep anything ===')
  process.env.DSH_NDM_PARTIAL_DAYS = '0'
  dest = fixture('never-keep', { ageDays: 0 })
  await startPlugin()
  check('with 0 days, even a fresh partial is swept', !existsSync(`${dest}.part`))
  delete process.env.DSH_NDM_PARTIAL_DAYS
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
