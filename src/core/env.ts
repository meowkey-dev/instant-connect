/**
 * Shared .env file loader.
 *
 * Supports KEY=value, KEY="value", KEY='value', blank lines, # comments.
 * Pass --env <path> on the command line to load a custom file.
 * Falls back to the caller-provided defaultPath (recommended: user-space
 * path like ~/.instant-connect/.env), or to .env in the current working
 * directory if no default is given.
 * Real environment variables always win (never overwritten).
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export function loadEnvFile(defaultPath?: string): void {
  const idx = process.argv.indexOf('--env')
  const envPath = idx !== -1
    ? process.argv[idx + 1]
    : (defaultPath ?? join(process.cwd(), '.env'))
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}
