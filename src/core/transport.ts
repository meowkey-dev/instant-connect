/**
 * Shared MCP server + transport setup.
 *
 * Supports two modes:
 *   - stdio (default): for plugin/MCP use — single client via stdin/stdout
 *   - SSE (--sse flag): for standalone use — multiple clients via express SSE
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execSync } from 'child_process'

// In-memory ring buffer of recent stderr lines, exposed via GET /logs in SSE
// mode. Installed at module load so startup-time logs are captured too.
const LOG_BUFFER_SIZE = 500
const logBuffer: string[] = []

const origStderrWrite = process.stderr.write.bind(process.stderr)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
process.stderr.write = ((chunk: any, ...args: any[]) => {
  const text = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? ''
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    logBuffer.push(line)
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift()
  }
  return origStderrWrite(chunk, ...args)
}) as typeof process.stderr.write

function resolveGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

const SERVER_VERSION = resolveGitHash()
const PACKAGE_VERSION = process.env.npm_package_version ?? 'unknown'
const SERVER_STARTED_AT = new Date().toISOString()
const SERVER_START_MS = Date.now()

/** Returns true if --sse was passed on the command line. */
export function isSSEMode(): boolean {
  return process.argv.includes('--sse')
}

// Tool names advertised by MCP SDK's built-in OAuth flow. This server uses
// access.json-based auth, so the OAuth tools can never succeed — and when they
// fail, Claude Code bakes the failure into its deferred_tools_delta records,
// which get replayed on every resume and require manual MCP reconnect to clear.
// Suppress them at the transport layer so consumers don't have to think
// about it.
const SUPPRESSED_TOOL_NAMES = new Set(['authenticate', 'complete_authentication'])

/** Create an MCP Server with claude/channel capability. */
export function createServer(name: string, version: string, instructions: string): Server {
  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions,
    },
  )

  const originalSet = server.setRequestHandler.bind(server)
  server.setRequestHandler = ((schema: Parameters<typeof originalSet>[0], handler: Parameters<typeof originalSet>[1]) => {
    if (schema === ListToolsRequestSchema) {
      const wrapped = (async (req: unknown, extra: unknown) => {
        const res = await (handler as (r: unknown, e: unknown) => Promise<{ tools?: Array<{ name: string }> }>)(req, extra)
        if (res && Array.isArray(res.tools)) {
          res.tools = res.tools.filter(t => !SUPPRESSED_TOOL_NAMES.has(t.name))
        }
        return res
      }) as typeof handler
      return originalSet(schema, wrapped)
    }
    if (schema === CallToolRequestSchema) {
      const wrapped = (async (req: { params: { name: string } }, extra: unknown) => {
        if (SUPPRESSED_TOOL_NAMES.has(req.params.name)) {
          return {
            content: [{ type: 'text', text: `tool "${req.params.name}" is not available on this server` }],
            isError: true,
          }
        }
        return (handler as (r: unknown, e: unknown) => unknown)(req, extra)
      }) as typeof handler
      return originalSet(schema, wrapped)
    }
    return originalSet(schema, handler)
  }) as typeof server.setRequestHandler

  return server
}

// ── SSE mode ────────────────────────────────────────────────────────────────

export type SSEClient<T = unknown> = {
  server: Server
  transport: SSEServerTransport
  data: T
}

export type SSESetupOptions<T> = {
  name: string
  port: number
  createServer: () => Server
  /** Called when a new SSE client connects. Return per-session data (e.g. filter sets). */
  onConnect: (sessionId: string, req: { query: Record<string, unknown> }) => T
  onDisconnect?: (sessionId: string) => void
}

/**
 * Set up SSE transport with express. Returns the live clients map so the
 * caller can iterate over sessions to deliver notifications.
 */
export async function setupSSE<T>(opts: SSESetupOptions<T>): Promise<Map<string, SSEClient<T>>> {
  const expressMod = (await import('express')).default
  const clients = new Map<string, SSEClient<T>>()
  const app = expressMod()

  app.get('/sse', async (req, res) => {
    const server = opts.createServer()
    const transport = new SSEServerTransport('/messages', res)
    await server.connect(transport)
    const sessionId = transport.sessionId
    const data = opts.onConnect(sessionId, req)
    clients.set(sessionId, { server, transport, data })

    // Send SSE keepalive comments every 30s to prevent idle-timeout disconnects.
    // Standard SSE practice: lines starting with ':' are comments, ignored by clients.
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n')
      } catch {
        clearInterval(keepalive)
      }
    }, 30_000)

    res.on('close', () => {
      clearInterval(keepalive)
      clients.delete(sessionId)
      opts.onDisconnect?.(sessionId)
      process.stderr.write(
        `${opts.name}: client disconnected sessionId=${sessionId} (${clients.size} remaining)\n`,
      )
    })
  })

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined
    if (!sessionId) {
      res.status(400).send('Missing sessionId')
      return
    }
    const session = clients.get(sessionId)
    if (!session) {
      res.status(400).send('No active SSE session for sessionId')
      return
    }
    await session.transport.handlePostMessage(req, res)
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/status', (_req, res) => {
    res.json({
      server: opts.name,
      uptime_seconds: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      connected_clients: clients.size,
      version: SERVER_VERSION,
      package_version: PACKAGE_VERSION,
      started_at: SERVER_STARTED_AT,
    })
  })

  app.get('/logs', (req, res) => {
    const rawLines = parseInt(req.query.lines as string, 10)
    const lines = Number.isFinite(rawLines) && rawLines > 0
      ? Math.min(rawLines, LOG_BUFFER_SIZE)
      : 50
    const filter = req.query.filter as string | undefined
    let result = logBuffer.slice(-lines)
    if (filter) result = result.filter(line => line.includes(filter))
    res.json({ count: result.length, lines: result })
  })

  // Catch-all 404 for any unmatched route. The MCP client (e.g. Claude Code)
  // probes OAuth discovery paths — /.well-known/oauth-authorization-server,
  // /.well-known/oauth-protected-resource, /register, /authorize, /token — to
  // decide whether to enter an auth flow. Express's default 404 is an HTML
  // page, which the client can't parse as an OAuth response and reports as
  // "Invalid OAuth error response: Cannot POST /register", leaving the MCP
  // stuck in a "needs authentication" state across resumes. A uniform JSON
  // 404 signals "this path does not exist" cleanly for every probe — the
  // client treats the server as non-OAuth and connects unauthenticated.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })

  app.listen(opts.port, () => {
    process.stderr.write(`${opts.name}: listening on http://localhost:${opts.port}\n`)
  })

  return clients
}

// ── Stdio mode ──────────────────────────────────────────────────────────────

/** Connect a server via stdio transport. */
export async function setupStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport())
}
