import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  acquireMuxLock,
  defaultMuxLockDeps,
  lockFileName,
  LockHeldError,
  type MuxLockDeps,
} from '../src/mux/lock.js'

// Real filesystem tests in a fresh tmp dir per test. The lock module's fs
// operations are injectable (MuxLockDeps); most tests use the defaults, and
// a couple override fsyncSync or stretch the staleness re-read delay to
// deterministically exercise the reclaim paths.

// Long enough that a helper child (node -e boots in ~20ms) is guaranteed to
// have rewritten the lockfile before the acquire's second read lands.
const LONG_STALE_VERIFY_DELAY_MS = 2000

describe('mux single-instance lock', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-lock-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('acquires and records the holder pid in the lockfile', () => {
    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.equal(readFileSync(lock.path, 'utf8'), String(process.pid))
    lock.release()
  })

  it('second acquire for the same mux+target throws LockHeldError with holderPid', () => {
    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.throws(
      () => acquireMuxLock(dir, 'tmux', 'w1:p3', 9_999_999),
      (err: unknown) =>
        err instanceof LockHeldError && err.holderPid === process.pid && err.path === lock.path,
    )
    lock.release()
  })

  it('release() lets a later acquire for the same mux+target succeed', () => {
    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    lock.release()
    const lock2 = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.equal(existsSync(lock.path), true)
    lock2.release()
  })

  it('release() is idempotent and tolerates an already-gone lockfile', () => {
    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    lock.release()
    lock.release()
    assert.equal(existsSync(lock.path), false)
  })

  it('a stale lock (dead holder pid) is reclaimed', () => {
    // Spawn and reap a throwaway child; its pid is now dead (ESRCH).
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    assert.ok(deadPid > 0)

    acquireMuxLock(dir, 'herdr', 'w1:p3', deadPid)
    const lock = acquireMuxLock(dir, 'herdr', 'w1:p3')
    assert.equal(readFileSync(lock.path, 'utf8'), String(process.pid))
    lock.release()
  })

  it('a young empty lockfile is held-by-unknown, never reclaimed', () => {
    // Simulates a contender reading between the holder's openSync and
    // writeSync: empty content younger than the stale-age threshold must not
    // be unlinked as stale.
    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, '')
    assert.throws(
      () => acquireMuxLock(dir, 'tmux', 'w1:p3'),
      (err: unknown) => err instanceof LockHeldError && Number.isNaN(err.holderPid) && err.path === path,
    )
    assert.equal(existsSync(path), true)
  })

  it('an old empty lockfile (crash relic) is reclaimed', () => {
    // A holder that died between openSync and writeSync leaves an empty file;
    // once it is older than the stale-age threshold it is a crash relic and
    // must be auto-reclaimed instead of stuck held-by-unknown forever.
    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, '')
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(path, old, old)

    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.equal(readFileSync(lock.path, 'utf8'), String(process.pid))
    lock.release()
  })

  it('garbage lockfile content is held-by-unknown, never reclaimed', () => {
    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, 'not-a-pid!!')
    assert.throws(
      () => acquireMuxLock(dir, 'tmux', 'w1:p3'),
      (err: unknown) => err instanceof LockHeldError && Number.isNaN(err.holderPid) && err.path === path,
    )
    assert.equal(existsSync(path), true)
  })

  it('a lockfile naming our own pid (pid recycle) is reclaimed as stale', () => {
    // A restarted process whose pid was recycled to match its own previous
    // instance's lockfile must not self-block: holderPid === caller pid is
    // stale and reclaimable.
    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, String(process.pid))
    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.equal(readFileSync(lock.path, 'utf8'), String(process.pid))
    lock.release()
  })

  it('differing reads settling on a dead pid reclaim the free lock', () => {
    // Simulate torn content: a helper child rewrites the lockfile (to another
    // dead pid) at boot, so the two reads differ. A dead second read proves
    // the lock is free, so it is reclaimed and the acquire proceeds.
    const dead1 = spawnSync(process.execPath, ['-e', '']).pid
    const dead2 = spawnSync(process.execPath, ['-e', '']).pid
    assert.ok(dead1 > 0 && dead2 > 0 && dead1 !== dead2)

    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, String(dead1))
    const rewriter = spawn(
      process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(String(dead2))})`],
      { stdio: 'ignore' },
    )
    rewriter.unref()

    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3', process.pid, LONG_STALE_VERIFY_DELAY_MS)
    assert.equal(readFileSync(lock.path, 'utf8'), String(process.pid))
    lock.release()
  })

  it('differing reads with an unknown second read are held-by-unknown, never reclaimed', () => {
    // The child truncates the lockfile to empty at boot, so the second read
    // sees mid-write content — held-by-unknown even though the first read
    // named a dead pid.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    assert.ok(deadPid > 0)

    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, String(deadPid))
    const rewriter = spawn(
      process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, '')`],
      { stdio: 'ignore' },
    )
    rewriter.unref()

    assert.throws(
      () => acquireMuxLock(dir, 'tmux', 'w1:p3', process.pid, LONG_STALE_VERIFY_DELAY_MS),
      (err: unknown) => err instanceof LockHeldError && Number.isNaN(err.holderPid) && err.path === path,
    )
    assert.equal(existsSync(path), true)
  })

  it('a lockfile that vanishes mid-check (ENOENT) is retried, not held-by-unknown', () => {
    // A helper child unlinks the stale lockfile at boot. The acquire must
    // treat ENOENT as "released" and retry, ending in a successful
    // acquisition rather than a spurious LockHeldError.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    assert.ok(deadPid > 0)

    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    writeFileSync(path, String(deadPid))
    const reaper = spawn(
      process.execPath,
      ['-e', `require('fs').unlinkSync(${JSON.stringify(path)})`],
      { stdio: 'ignore' },
    )
    reaper.unref()

    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.equal(readFileSync(lock.path, 'utf8'), String(process.pid))
    lock.release()
  })

  it('a write/fsync failure after openSync cleans up the partial lockfile and fd', () => {
    const path = join(dir, lockFileName('tmux', 'w1:p3'))
    const deps: MuxLockDeps = {
      ...defaultMuxLockDeps,
      fsyncSync: (() => {
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' })
      }) as MuxLockDeps['fsyncSync'],
    }

    assert.throws(
      () => acquireMuxLock(dir, 'tmux', 'w1:p3', process.pid, 100, 100, deps),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EIO',
    )

    // The partial lockfile and fd must not linger — a later acquire succeeds.
    assert.equal(existsSync(path), false)
    const lock = acquireMuxLock(dir, 'tmux', 'w1:p3')
    lock.release()
  })

  it('different targets and different muxes do not conflict', () => {
    const a = acquireMuxLock(dir, 'tmux', 'w1:p3')
    const b = acquireMuxLock(dir, 'tmux', 'w1:p4')
    const c = acquireMuxLock(dir, 'herdr', 'w1:p3')
    a.release()
    b.release()
    c.release()
  })

  it('targets that differ only by punctuation do not collide', () => {
    // "w1:p3" and "w1_p3" are unrelated panes — the lossless hash must give
    // them distinct lockfiles (the old sanitize() collapsed both to w1_p3).
    const a = acquireMuxLock(dir, 'tmux', 'w1:p3')
    const b = acquireMuxLock(dir, 'tmux', 'w1_p3')
    a.release()
    b.release()
  })

  it('target whitespace is trimmed so variants of the same pane conflict', () => {
    // "w1:p3 " and "w1:p3" name the same pane; normalized to one lockfile, so
    // the second acquire must be refused rather than bypassing the lock.
    const a = acquireMuxLock(dir, 'tmux', 'w1:p3')
    assert.throws(
      () => acquireMuxLock(dir, 'tmux', 'w1:p3 ', 9_999_999),
      (err: unknown) => err instanceof LockHeldError && err.holderPid === process.pid,
    )
    a.release()
  })

  it('lockFileName lowercases the mux name and preserves target case', () => {
    // Mux name case-insensitive: 'Tmux' and 'tmux' resolve to the same file.
    assert.equal(lockFileName('Tmux', 'w1:p3'), lockFileName('tmux', 'w1:p3'))
    // Target case preserved: distinct files for distinct pane spellings.
    assert.notEqual(lockFileName('tmux', 'w1:p3'), lockFileName('tmux', 'W1:P3'))
    // Trailing whitespace trimmed.
    assert.equal(lockFileName('tmux', 'w1:p3 '), lockFileName('tmux', 'w1:p3'))
    assert.match(lockFileName('tmux', 'w1:p3'), /^tmux-[0-9a-f]{16}\.lock$/)
  })
})

// ── Cross-process lock races ────────────────────────────────────────────────
// Real child processes run the lock-race fixture against the real lock module
// (bun runs the .ts fixture directly; real node gets the tsx loader via
// `--import tsx`). No fakes: O_EXCL arbitration across processes.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const raceFixture = join(repoRoot, 'test', 'fixtures', 'lock-race.ts')

const runningUnderBun = (process.versions as Record<string, string | undefined>).bun !== undefined

function raceChildArgs(mode: string, dir: string, target: string): string[] {
  const args = [raceFixture, mode, dir, 'tmux', target]
  return runningUnderBun ? args : ['--import', 'tsx', ...args]
}

interface RaceChildResult {
  pid: number
  exited: boolean
  code: number | null
  stdout: string
  stderr: string
}

interface RaceChild {
  child: ChildProcess
  pid: number
  /** Settles when the child exits, or (acquire-hold) when it reports acquired. */
  result: Promise<RaceChildResult>
  /** Settles only on the child's actual exit. */
  exit: Promise<number | null>
  kill(): void
}

const spawnedChildren: ChildProcess[] = []

function spawnRaceChild(mode: string, dir: string, target: string): RaceChild {
  const child = spawn(process.execPath, raceChildArgs(mode, dir, target), {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawnedChildren.push(child)

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => { stdout += d })
  child.stderr.on('data', (d: Buffer) => { stderr += d })

  const exit = new Promise<number | null>(resolve => {
    // 'close' (not 'exit') fires after stdio pipes are fully drained, so the
    // captured stdout/stderr is complete when the result resolves.
    child.on('close', code => resolve(code))
  })

  const result = new Promise<RaceChildResult>(resolve => {
    child.stdout.on('data', () => {
      if (mode === 'acquire-hold' && stdout.includes('LOCK_ACQUIRED')) {
        resolve({ pid: child.pid ?? 0, exited: false, code: null, stdout, stderr })
      }
    })
    void exit.then(code => {
      resolve({ pid: child.pid ?? 0, exited: true, code, stdout, stderr })
    })
  })

  return {
    child,
    pid: child.pid ?? 0,
    result,
    exit,
    kill: () => child.kill('SIGTERM'),
  }
}

function lockPathFor(dir: string, target: string): string {
  return join(dir, lockFileName('tmux', target))
}

describe('cross-process lock race', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-lock-race-'))
  })

  afterEach(() => {
    // Safety net for a winner that is still holding when a test finishes.
    for (const c of spawnedChildren) {
      if (c.exitCode === null) c.kill('SIGTERM')
    }
    spawnedChildren.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  it('exactly one of N concurrent acquisitions wins, the rest get LockHeldError', async () => {
    const N = 8
    const racers = Array.from({ length: N }, () => spawnRaceChild('acquire-hold', dir, 'w1:p3'))
    const results = await Promise.all(racers.map(r => r.result))

    const winners = results.filter(r => r.stdout.includes('LOCK_ACQUIRED'))
    const losers = results.filter(r => r.stderr.includes('LOCK_HELD'))
    assert.equal(winners.length, 1)
    assert.equal(losers.length, N - 1)
    for (const l of losers) {
      assert.equal(l.exited, true)
      assert.notEqual(l.code, 0)
    }
    const winner = racers.find(r => r.pid === winners[0].pid)
    assert.ok(winner)
    try {
      // Winner is still running and its pid is in the lockfile.
      assert.equal(winner.child.exitCode === null, true)
      assert.equal(readFileSync(lockPathFor(dir, 'w1:p3'), 'utf8'), String(winners[0].pid))
    } finally {
      winner.kill()
      await winner.exit
    }
  })

  it('a live winner keeps the lock; losers do not unlink it and new acquires are refused', async () => {
    const winner = spawnRaceChild('acquire-hold', dir, 'w1:p3')
    const w = await winner.result
    assert.equal(w.stdout.includes('LOCK_ACQUIRED'), true)

    try {
      // Concurrent losers each get a LockHeldError and exit nonzero.
      const losers = Array.from({ length: 4 }, () => spawnRaceChild('acquire', dir, 'w1:p3'))
      for (const l of losers) {
        const r = await l.result
        assert.equal(r.exited, true)
        assert.notEqual(r.code, 0)
        assert.ok(r.stderr.includes('LOCK_HELD'), `expected LOCK_HELD, got: ${r.stderr}`)
      }

      // No loser's reclaim path unlinked the winner's lock.
      assert.equal(readFileSync(lockPathFor(dir, 'w1:p3'), 'utf8'), String(w.pid))

      // A brand-new process is also refused while the winner lives.
      const next = spawnRaceChild('acquire', dir, 'w1:p3')
      const nr = await next.result
      assert.equal(nr.exited, true)
      assert.notEqual(nr.code, 0)
      assert.ok(nr.stderr.includes('LOCK_HELD'))
      assert.equal(readFileSync(lockPathFor(dir, 'w1:p3'), 'utf8'), String(w.pid))
    } finally {
      winner.kill()
      await winner.exit
    }
  })

  it('a stale lock (dead winner) is reclaimed end-to-end by a new process', async () => {
    // Winner acquires and exits without releasing → stale lock naming its pid.
    const first = await spawnRaceChild('acquire', dir, 'w1:p3').result
    assert.equal(first.exited, true)
    assert.equal(first.code, 0)
    assert.ok(first.stdout.includes('LOCK_ACQUIRED'))
    assert.equal(readFileSync(lockPathFor(dir, 'w1:p3'), 'utf8'), String(first.pid))

    // A new process reclaims the dead-pid lock and acquires.
    const second = await spawnRaceChild('acquire', dir, 'w1:p3').result
    assert.equal(second.exited, true)
    assert.equal(second.code, 0)
    assert.ok(second.stdout.includes('LOCK_ACQUIRED'))
    assert.equal(readFileSync(lockPathFor(dir, 'w1:p3'), 'utf8'), String(second.pid))
  })
})
