import { createHash } from 'node:crypto'
import {
  closeSync as nodeCloseSync,
  fsyncSync as nodeFsyncSync,
  mkdirSync as nodeMkdirSync,
  openSync as nodeOpenSync,
  readFileSync as nodeReadFileSync,
  statSync as nodeStatSync,
  unlinkSync as nodeUnlinkSync,
  writeSync as nodeWriteSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * Single-instance lock for mux-based inbound delivery.
 *
 * Two instant-connect processes pointed at the same mux pane both receive
 * the same chat messages (each registers its own platform event queue) and
 * would paste duplicates. The lock turns that silent double-delivery into a
 * loud startup failure: the second process exits with LockHeldError naming
 * the holder's pid.
 *
 * Implementation: atomic O_EXCL create containing the holder pid, fsynced
 * before close so the written pid is durable. Staleness is decided by
 * agreement: the lockfile is read, and after a short delay read again. Only
 * when both reads agree on a pid that is not alive (or is our own pid — a
 * recycled pid from a previous instance) is the lock reclaimed. Two reads
 * that differ mean a holder is mid-write: a dead-pid second read means the
 * lock is demonstrably free and is reclaimed, while a live or unknown second
 * read counts as held-by-unknown and is never reclaimed.
 *
 * fsync guards the durability of the written bytes, not the create: a crash
 * between openSync and writeSync still leaves an empty file behind. Empty
 * content is held-by-unknown while young (a live holder's open→write window
 * is milliseconds) and auto-reclaimed only once its mtime is older than the
 * stale-age threshold (default 5 minutes).
 *
 * The lock assumes local-disk atomic writes. On NFS a torn lockfile can read
 * the same stable-torn content on both reads and be reclaimed while its
 * holder is still alive — this is why the lock dir is ~/.instant-connect/locks
 * (a local home); NFS-mounted homes are unsupported. PID reuse has a related
 * limitation: if a live contender is assigned the pid a stale lockfile names,
 * the two processes can each consider the other's lock stale and steal it
 * back and forth. Eliminating both cases requires flock(2), which is not
 * portable to macOS; they are accepted limitations.
 *
 * Lockfile names are `sanitize(muxName) + "-" + sha256(target.trim()).slice(0,16)
 * + ".lock"` — see lockFileName. Targets are trimmed and hashed losslessly, so
 * spelling variants of one pane ("w1:p3" vs "w1:p3 ") map to a single file
 * while distinct panes ("w1:p3" vs "w1_p3") get distinct lowercase-hex names.
 * On a case-insensitive filesystem (macOS APFS default) distinct names are not
 * guaranteed distinct files; the collision direction is safe there — two panes
 * sharing one lockfile only causes a false LockHeldError, never a lock bypass.
 * Lockfiles written under the older sanitized-target naming are harmless
 * leftovers and are never looked up again.
 */

export interface MuxLock {
  readonly path: string
  release(): void
}

export class LockHeldError extends Error {
  constructor(
    readonly holderPid: number,
    readonly path: string,
  ) {
    super(Number.isNaN(holderPid)
      ? `lock held by an unknown process: ${path}`
      : `lock held by pid ${holderPid}: ${path}`)
    this.name = 'LockHeldError'
  }
}

/**
 * Injectable side-effecting dependencies. Defaults to the real node:fs
 * implementations; tests pass fakes/overrides here instead of mutating frozen
 * ESM module namespaces (see the TmuxInboundDeps/HerdrInboundDeps precedent).
 */
export interface MuxLockDeps {
  mkdirSync: typeof nodeMkdirSync
  openSync: typeof nodeOpenSync
  writeSync: typeof nodeWriteSync
  fsyncSync: typeof nodeFsyncSync
  closeSync: typeof nodeCloseSync
  readFileSync: typeof nodeReadFileSync
  statSync: typeof nodeStatSync
  unlinkSync: typeof nodeUnlinkSync
}

export const defaultMuxLockDeps: MuxLockDeps = {
  mkdirSync: nodeMkdirSync,
  openSync: nodeOpenSync,
  writeSync: nodeWriteSync,
  fsyncSync: nodeFsyncSync,
  closeSync: nodeCloseSync,
  readFileSync: nodeReadFileSync,
  statSync: nodeStatSync,
  unlinkSync: nodeUnlinkSync,
}

const DEFAULT_STALE_VERIFY_DELAY_MS = 100
const DEFAULT_STALE_AGE_MS = 5 * 60 * 1000

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Lockfile basename for a mux name + target.
 *
 * Normalization: the mux name is lowercased then sanitized (mux names are a
 * small fixed set — tmux, herdr — and case-insensitive in practice); the
 * target is whitespace-trimmed but its case is preserved (tmux targets are
 * case-sensitive, herdr pane ids are lowercase by convention). The target is
 * hashed losslessly (sha256, 16 lowercase-hex chars) instead of sanitized, so
 * distinct targets get distinct names and any path-traversal characters are
 * neutralized. Distinct names are not guaranteed distinct files on a
 * case-insensitive filesystem (macOS APFS default); that collision direction
 * is safe here — a shared lockfile only yields a false LockHeldError.
 */
export function lockFileName(muxName: string, target: string): string {
  const name = sanitize(muxName.toLowerCase())
  const hash = createHash('sha256').update(target.trim()).digest('hex').slice(0, 16)
  return `${name}-${hash}.lock`
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: alive but owned by another user. ESRCH: dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number): void {
  // Blocking sleep; this module is fully sync. Atomics.wait with a timeout is
  // legal on the main thread in Node (unlike browsers) and needs no imports.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Lockfile contents; null when the file has vanished (ENOENT). */
function readLockContent(deps: MuxLockDeps, path: string): string | null {
  try {
    return deps.readFileSync(path, 'utf8')
  } catch (err) {
    // ENOENT means the lock was released mid-check — the caller retries the
    // acquire instead of treating it as held. Any other read failure
    // (EACCES, EIO) counts as held-by-unknown.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : ''
  }
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0
}

function parsePid(content: string): number {
  return parseInt(content.trim(), 10)
}

/**
 * Classify lockfile contents from the caller's point of view:
 *   'held'    — a live pid that isn't ours,
 *   'stale'   — a dead pid, or our own pid (a previous instance's lock, or a
 *               pid recycle) — reclaimable,
 *   'unknown' — empty/garbage/unreadable — never reclaim directly; handled by
 *               the caller via age-based reclaim (see fileOlderThan).
 */
function classifyContent(content: string, callerPid: number): 'held' | 'stale' | 'unknown' {
  const holderPid = parsePid(content)
  if (!isValidPid(holderPid)) return 'unknown'
  if (holderPid === callerPid) return 'stale'
  return pidAlive(holderPid) ? 'held' : 'stale'
}

/**
 * True when the lockfile's mtime is older than `maxAgeMs`. Used to tell a
 * crash relic (holder died between openSync and writeSync — safe to reclaim
 * under the local-disk-atomic-writes assumption, where the open→write window
 * is milliseconds) from a live holder mid-write (never reclaim). A stat
 * failure means we cannot prove age — report as not old.
 */
function fileOlderThan(deps: MuxLockDeps, path: string, maxAgeMs: number): boolean {
  try {
    return Date.now() - deps.statSync(path).mtimeMs > maxAgeMs
  } catch {
    return false
  }
}

/** Reclaim the lockfile if it is old enough; otherwise throw held-by-unknown. */
function unknownOrReclaim(deps: MuxLockDeps, path: string, staleAgeMs: number): void {
  if (!fileOlderThan(deps, path, staleAgeMs)) throw new LockHeldError(NaN, path)
  reclaim(deps, path)
}

function reclaim(deps: MuxLockDeps, path: string): void {
  try {
    deps.unlinkSync(path)
  } catch {
    // raced with another reclaimer — the retry's openSync settles it
  }
}

export function acquireMuxLock(
  dir: string,
  muxName: string,
  target: string,
  pid: number = process.pid,
  staleVerifyDelayMs: number = DEFAULT_STALE_VERIFY_DELAY_MS,
  staleAgeMs: number = DEFAULT_STALE_AGE_MS,
  deps: MuxLockDeps = defaultMuxLockDeps,
): MuxLock {
  deps.mkdirSync(dir, { recursive: true })
  const path = join(dir, lockFileName(muxName, target))

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = deps.openSync(path, 'wx')
      try {
        deps.writeSync(fd, String(pid))
        deps.fsyncSync(fd)
        deps.closeSync(fd)
      } catch (err) {
        // write/fsync/close failed (ENOSPC/EIO) — don't leave a partial
        // lockfile and fd behind, or the lock would be stuck held-by-unknown.
        try { deps.closeSync(fd) } catch { /* already closed — ignore */ }
        try { deps.unlinkSync(path) } catch { /* never fully created — ignore */ }
        throw err
      }
      let released = false
      return {
        path,
        release() {
          if (released) return
          released = true
          try {
            deps.unlinkSync(path)
          } catch {
            // already gone — fine
          }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Staleness by agreement: a single read can catch torn content (e.g.
      // "12" cut from "12345") that still parses to a valid pid, so re-read
      // after a delay and only reclaim on agreement (or a free second read).
      const first = readLockContent(deps, path)
      if (first === null) continue // lock vanished — retry the acquire
      const verdict1 = classifyContent(first, pid)
      if (verdict1 === 'held') throw new LockHeldError(parsePid(first), path)
      if (verdict1 === 'unknown') {
        // Unparseable: a young file is a live holder mid-write (open→write is
        // milliseconds) — held-by-unknown; an old one is a crash relic left
        // by a holder that died between openSync and writeSync — reclaim.
        unknownOrReclaim(deps, path, staleAgeMs)
        continue
      }
      sleepSync(staleVerifyDelayMs)
      const second = readLockContent(deps, path)
      if (second === null) continue // released during the wait — retry
      if (second !== first) {
        // Mid-write or replaced between reads. A live or unknown second read
        // means a holder may still be writing — held-by-unknown, never
        // reclaim (unless the unknown content is old enough). A dead (or
        // self) pid proves the lock is free: reclaim.
        const verdict2 = classifyContent(second, pid)
        if (verdict2 === 'held') throw new LockHeldError(parsePid(second), path)
        if (verdict2 === 'unknown') {
          unknownOrReclaim(deps, path, staleAgeMs)
          continue
        }
        reclaim(deps, path)
        continue
      }
      // Reads agree on a dead (or self) pid — confirmed stale, reclaim.
      reclaim(deps, path)
    }
  }

  // Reclaim succeeded but the retry still collided — someone else won.
  const late = readLockContent(deps, path)
  const latePid = late === null ? NaN : parsePid(late)
  throw new LockHeldError(
    isValidPid(latePid) && pidAlive(latePid) && latePid !== pid ? latePid : NaN,
    path,
  )
}
