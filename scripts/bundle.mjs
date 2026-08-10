#!/usr/bin/env node
/**
 * esbuild bundler — port of machine/plugins/build/build.mjs.
 *
 * Bundles src/index.ts + all npm dependencies into a single self-contained
 * ESM file (dist/server.js) with zero runtime module resolution.
 *
 * Usage: node scripts/bundle.mjs
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src', 'index.ts')
const outfile = resolve(root, 'dist', 'server.js')

// Optional native/transitive deps wrapped in try/catch require()s by bundled
// CJS deps (ws, discord.js-style). Not needed at runtime; keep external so
// esbuild does not fail resolving them.
const optionalExternals = [
  'zlib-sync',
  'bufferutil',
  'utf-8-validate',
]

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: optionalExternals,
  logLevel: 'info',
  // Some bundled CJS deps (express, ws) reference `__dirname` / `require`;
  // provide an ESM-compatible shim banner.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __furl } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __furl(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
})

console.error(`bundled src/index.ts -> dist/server.js`)
