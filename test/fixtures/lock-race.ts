/**
 * Cross-process lock race fixture, run as a child of test/mux-lock.test.ts.
 *
 * Usage:
 *   lock-race.ts acquire <dir> <muxName> <target>
 *   lock-race.ts acquire-hold <dir> <muxName> <target>
 *
 * `acquire` acquires the lock and exits 0, printing `LOCK_ACQUIRED <pid>` to
 * stdout. `acquire-hold` does the same but keeps the process alive (a timer
 * handle) so a test can assert the lock is still held, then SIGTERM it. On
 * LockHeldError (or any other error) it prints `LOCK_HELD <pid>` (or
 * `LOCK_ERROR <msg>`) to stderr and exits 1. The lock is deliberately not
 * released on exit so tests exercise the stale-pid reclaim path.
 */
import { acquireMuxLock, LockHeldError } from '../../src/mux/lock.js'

const mode = process.argv[2]
const dir = process.argv[3]
const muxName = process.argv[4]
const target = process.argv[5]

try {
  acquireMuxLock(dir, muxName, target)
  process.stdout.write(`LOCK_ACQUIRED ${process.pid}\n`)
  if (mode === 'acquire-hold') {
    setInterval(() => {}, 1000)
  } else {
    process.exit(0)
  }
} catch (err) {
  if (err instanceof LockHeldError) {
    process.stderr.write(`LOCK_HELD ${err.holderPid}\n`)
  } else {
    process.stderr.write(`LOCK_ERROR ${(err as Error).message}\n`)
  }
  process.exit(1)
}
