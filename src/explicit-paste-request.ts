export class ExplicitPasteRequestTracker {
  private pending = 0
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly timeoutMs: number) {}

  request(): void {
    this.pending += 1
  }

  arm(): void {
    if (this.pending <= 0) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.pending > 0) this.pending -= 1
    }, this.timeoutMs)
    this.timers.add(timer)
  }

  consume(): boolean {
    if (this.pending <= 0) return false
    this.pending -= 1
    const timer = this.timers.values().next().value
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(timer)
    }
    return true
  }
}
