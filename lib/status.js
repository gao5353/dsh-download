/**
 * Download status registry — the data layer a UI reads.
 *
 * Why this exists before any UI does
 * ----------------------------------
 * A progress panel needs three things: a list of downloads, live progress for the one in
 * flight, and the reason when one fails. Today that information exists only inside a single
 * blocking tool call, so it is invisible to everything else — no UI inside dsh could show it,
 * and neither could anything outside dsh.
 *
 * This module makes it durable. Every download is recorded here and mirrored to a small JSON
 * file, so the same data can be read by a panel inside dsh, by a viewer outside it, or by a
 * person with a text editor. That ordering is deliberate: the file is the foundation either
 * way, so building it is never wasted work whichever presentation wins.
 *
 * Design constraints
 * ------------------
 * - **No token cost.** Nothing here touches the model context. The tool still returns one
 *   short line; the registry is a side channel.
 * - **Never fail a download because status recording failed.** Every write is best-effort: a
 *   read-only home directory or a locked file must not break a transfer.
 * - **Atomic writes.** A UI may read the file at any moment, so it is written to a temporary
 *   sibling and renamed; a reader never sees a half-written document.
 * - **Bounded.** Only the most recent entries are kept, so the file cannot grow without limit.
 * - **Restorable.** The mirror is not write-only: a store can adopt the previous process's
 *   history, so a panel does not start blank after every dsh restart.
 *
 * @module dsh-download/status
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** States a download can be in. `downloading` is the only non-terminal one. */
export const STATE = {
  downloading: 'downloading',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  // Recorded on restore, never during a run: an entry the previous process still called
  // `downloading` when it died did not finish, but calling it a download failure would blame the
  // transfer for something that was never its fault.
  interrupted: 'interrupted',
}

/** How many finished entries to retain. */
const DEFAULT_HISTORY = 25

/** Minimum gap between progress writes, so a fast transfer cannot hammer the disk. */
const DEFAULT_FLUSH_MS = 1000

/** Human-readable size, duplicated here to keep the module dependency-free. */
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

/** A short, stable, human-readable id; a UI shows it and a person can quote it. */
function makeId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const salt = Math.floor(Math.random() * 4096)
    .toString(16)
    .padStart(3, '0')
  return `${stamp}-${salt}`
}

/**
 * Create a status registry.
 *
 * @param options - `path` for the mirror file, plus history and flush tuning. `restore` adopts
 *   the mirror's previous contents, so a fresh process still shows what earlier ones did.
 * @returns the registry API.
 */
export function createStatusStore(options = {}) {
  const filePath = options.path
  const maxHistory = options.maxHistory ?? DEFAULT_HISTORY
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
  const restore = options.restore === true

  /** Newest first. The live entry is always index 0 while a transfer runs. */
  const entries = []
  let lastFlush = 0
  let dirty = false

  const now = () => new Date().toISOString()

  /**
   * Write the mirror file atomically. Best-effort by design: a failure here is swallowed,
   * because status recording must never be able to break a download.
   */
  function flush(force = false) {
    if (filePath === undefined) return
    const stamp = Date.now()
    if (!force && (!dirty || stamp - lastFlush < flushMs)) return
    lastFlush = stamp
    dirty = false
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.tmp`
      const document = {
        version: 1,
        updatedAt: now(),
        // `active` is what a progress panel watches; `recent` is what a failure list shows.
        active: entries.filter((entry) => entry.state === STATE.downloading),
        recent: entries.filter((entry) => entry.state !== STATE.downloading).slice(0, maxHistory),
      }
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      // Rename is atomic on the same volume, so a reader never observes a partial file.
      renameSync(temporary, filePath)
    } catch {
      /* status is a side channel; never let it break the transfer */
    }
  }

  /** Trim finished entries beyond the retained history. */
  function trim() {
    let finished = 0
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].state === STATE.downloading) continue
      finished += 1
      if (finished > maxHistory) entries.splice(index, 1)
    }
  }

  /** Whether a value read back from disk has the shape of an entry. */
  function isEntry(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.state === 'string'
    )
  }

  /** Sort key for restoring order: the most recent timestamp an entry carries. */
  function stampOf(entry) {
    const parsed = Date.parse(entry.finishedAt ?? entry.updatedAt ?? entry.startedAt ?? '')
    return Number.isFinite(parsed) ? parsed : 0
  }

  /**
   * Adopt the mirror file's history, if asked to.
   *
   * Two things are worth keeping and one is not. Finished entries are kept as they are — they
   * are what a panel lists, and losing them on every restart is what makes such a panel feel
   * useless. An entry still marked `downloading` is *not* kept as live: this process is not
   * running it, so showing it as in-flight would be a lie that never resolves. It is recorded as
   * interrupted instead, which says what actually happened — and the reconciled document is
   * written back at once, so anything else reading the file agrees.
   */
  function restoreFromDisk() {
    if (!restore || filePath === undefined || !existsSync(filePath)) return
    try {
      const raw = readFileSync(filePath, 'utf8')
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      const document = JSON.parse(text)
      if (document === null || typeof document !== 'object') return

      for (const entry of Array.isArray(document.recent) ? document.recent : []) {
        if (isEntry(entry)) entries.push(entry)
      }
      for (const entry of Array.isArray(document.active) ? document.active : []) {
        if (!isEntry(entry)) continue
        entries.push({
          ...entry,
          state: STATE.interrupted,
          percent: null,
          speedBps: null,
          error: 'the download did not finish: dsh restarted while it was in flight',
          hint: 'Nothing was left in a half-written state that the downloader would trust; call download_file again.',
          finishedAt: entry.updatedAt ?? now(),
          updatedAt: entry.updatedAt ?? now(),
        })
      }

      if (entries.length === 0) return
      // Newest first is the order the rest of this module assumes (`trim` splices from the end).
      entries.sort((left, right) => stampOf(right) - stampOf(left))
      trim()
      dirty = true
      flush(true)
    } catch {
      /* an unreadable mirror starts empty rather than guessing */
    }
  }

  // Adopt the previous process's mirror before anyone can read this registry, so the first
  // snapshot a panel asks for already carries the history instead of looking as if it were lost.
  restoreFromDisk()

  return {
    /** The mirror file this registry writes, or undefined when disabled. */
    path: filePath,

    /**
     * Record a download that is starting.
     * @param intent - url, destination, engine, the declared total, and how many connections it
     *   intends to use (a panel shows it, so a stalled transfer is visibly narrower than a busy one).
     * @returns the entry, whose `id` identifies it for later updates.
     */
    begin({ url, dest, engine, total = null, connections = null }) {
      const entry = {
        id: makeId(),
        url,
        dest,
        engine,
        state: STATE.downloading,
        bytes: 0,
        total,
        percent: total === null || total === 0 ? null : 0,
        speedBps: null,
        method: null,
        connections: Number.isFinite(connections) && connections > 0 ? connections : null,
        startedAt: now(),
        updatedAt: now(),
        finishedAt: null,
        error: null,
        hint: null,
      }
      entries.unshift(entry)
      trim()
      dirty = true
      flush(true)
      return entry
    },

    /**
     * Update progress. Called often, so the file is only rewritten on the flush interval.
     * @param id - the entry id.
     * @param update - byte count, declared total, transfer method, connection count, or phase label.
     */
    progress(id, update) {
      const entry = entries.find((item) => item.id === id)
      if (entry === undefined) return

      if (typeof update.bytes === 'number') entry.bytes = update.bytes
      if (typeof update.total === 'number' && update.total > 0) entry.total = update.total
      if (typeof update.method === 'string') entry.method = update.method
      if (typeof update.phase === 'string') entry.phase = update.phase
      if (Number.isFinite(update.connections) && update.connections > 0) entry.connections = update.connections

      const elapsed = (Date.now() - Date.parse(entry.startedAt)) / 1000
      if (elapsed > 0.5 && entry.bytes > 0) entry.speedBps = Math.round(entry.bytes / elapsed)
      entry.percent =
        entry.total === null || entry.total === 0 ? null : Math.min(100, (entry.bytes / entry.total) * 100)
      entry.updatedAt = now()
      dirty = true
      flush()
    },

    /**
     * Mark a download finished, however it ended.
     * @param id - the entry id.
     * @param outcome - `ok`, plus bytes, method, connection count, or a failure reason and hint.
     */
    finish(id, outcome = {}) {
      const entry = entries.find((item) => item.id === id)
      if (entry === undefined) return

      if (typeof outcome.bytes === 'number') entry.bytes = outcome.bytes
      if (typeof outcome.method === 'string') entry.method = outcome.method
      if (Number.isFinite(outcome.connections) && outcome.connections > 0) {
        entry.connections = outcome.connections
      }
      if (typeof outcome.error === 'string') entry.error = outcome.error
      if (typeof outcome.hint === 'string') entry.hint = outcome.hint
      if (typeof outcome.dest === 'string') entry.dest = outcome.dest
      entry.state = outcome.ok
        ? STATE.completed
        : outcome.cancelled === true
          ? STATE.cancelled
          : STATE.failed
      // Only a completed transfer is 100%. Anything else keeps the last measured figure — a panel
      // that showed a failed download at 100% would be describing a file that is not there.
      entry.percent = entry.total === null ? null : outcome.ok === true ? 100 : entry.percent
      entry.finishedAt = now()
      entry.updatedAt = entry.finishedAt
      dirty = true
      flush(true)
      return entry
    },

    /** Current contents, for a host RPC or a test. */
    snapshot() {
      return {
        version: 1,
        updatedAt: now(),
        active: entries.filter((entry) => entry.state === STATE.downloading),
        recent: entries.filter((entry) => entry.state !== STATE.downloading).slice(0, maxHistory),
      }
    },

    /** Force a write, used when shutting down or by tests. */
    flushNow() {
      flush(true)
    },

    /** Read back what was written, for a UI that prefers the file. */
    read() {
      if (filePath === undefined || !existsSync(filePath)) return null
      try {
        return JSON.parse(readFileSync(filePath, 'utf8'))
      } catch {
        return null
      }
    },

    /** Remove the mirror file. */
    discard() {
      if (filePath === undefined) return
      rmSync(filePath, { force: true })
      rmSync(`${filePath}.tmp`, { force: true })
    },
  }
}

/** Default location of the mirror file, beside the settings file. */
export function statusFilePath(dshHome) {
  return join(dshHome, 'dsh-download.status.json')
}

export { human }
