/**
 * Mux-target interface — delivery of inbound chat messages to an agent hosted
 * in a terminal multiplexer (for agents without MCP claude/channel support).
 * Implementations may use terminal input (tmux) or a native agent API (herdr).
 */

export interface MuxDeliverResult {
  ok: boolean
  error?: string
  attempts: number
}

export interface Multiplexer {
  readonly name: string
  /**
   * Deliver `payload` to the agent identified by `target`.
   */
  paste(target: string, payload: string): Promise<MuxDeliverResult>
  /** Capture the last few lines of the pane (for verification/debugging). */
  capturePane(target: string, lines?: number): Promise<string>
  /**
   * Canonical identity for `target` (e.g. tmux pane id "%N"), so spellings of
   * the same pane ("mysess:1.1", "%5") hash to one lockfile. Optional: when
   * absent the caller uses `target` as-is.
   */
  canonicalize?(target: string): Promise<string>
}
