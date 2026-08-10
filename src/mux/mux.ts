/**
 * Multiplexer interface — delivery of inbound chat messages into a terminal
 * multiplexer pane running an agent session (for agents without MCP
 * claude/channel support). tmux is the first implementation; the interface
 * leaves room for others (zellij, etc.).
 */

export interface MuxDeliverResult {
  ok: boolean
  error?: string
  attempts: number
}

export interface Multiplexer {
  readonly name: string
  /**
   * Paste `payload` into the pane identified by `target`
   * (e.g. "sess:win.pane" for tmux) and submit it with Enter.
   */
  paste(target: string, payload: string): Promise<MuxDeliverResult>
  /** Capture the last few lines of the pane (for verification/debugging). */
  capturePane(target: string, lines?: number): Promise<string>
}
