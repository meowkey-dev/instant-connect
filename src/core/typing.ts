/**
 * Shared typing-indicator lifecycle manager.
 *
 * Chat services (Zulip, …) display the typing indicator for a short
 * window — on the order of 10s — after a typing event is sent. To keep the
 * indicator visible across a longer response, the event must be refreshed
 * periodically. TypingManager tracks per-channel refresh intervals so callers
 * can express the lifecycle as start/stop rather than managing timers inline.
 */

export type SendTypingFn = () => Promise<void> | void

export class TypingManager {
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map()
  private safetyTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  start(channelId: string, sendFn: SendTypingFn, intervalMs = 8000, maxMs = 3 * 60_000): void {
    this.stop(channelId)
    void Promise.resolve(sendFn()).catch(() => {})
    const handle = setInterval(() => {
      void Promise.resolve(sendFn()).catch(() => {})
    }, intervalMs)
    this.intervals.set(channelId, handle)
    const safety = setTimeout(() => this.stop(channelId), maxMs)
    this.safetyTimers.set(channelId, safety)
  }

  stop(channelId: string): void {
    const handle = this.intervals.get(channelId)
    if (handle !== undefined) {
      clearInterval(handle)
      this.intervals.delete(channelId)
    }
    const safety = this.safetyTimers.get(channelId)
    if (safety !== undefined) {
      clearTimeout(safety)
      this.safetyTimers.delete(channelId)
    }
  }

  stopAll(): void {
    for (const key of [...this.intervals.keys()]) this.stop(key)
  }

  isActive(channelId: string): boolean {
    return this.intervals.has(channelId)
  }
}
