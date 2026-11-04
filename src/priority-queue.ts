// A running WASM call cannot be preempted. Interactive queries go first at the next batch boundary.
export class PriorityQueue {
  private tasks: { interactive: boolean; run: () => Promise<void> }[] = [];
  private running = false;
  enqueue(run: () => Promise<void>, interactive = false) {
    this.tasks.push({ interactive, run });
    if (!this.running) void this.drain();
  }
  private async drain() {
    this.running = true;
    try {
      while (this.tasks.length) {
        const urgent = this.tasks.findIndex(t => t.interactive);
        const task = this.tasks.splice(urgent < 0 ? 0 : urgent, 1)[0];
        try { await task.run(); } catch { /* Tasks report their own errors. Keep the queue alive. */ }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { this.running = false; }
  }
}
