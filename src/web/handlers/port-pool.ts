// ─── Port pool ────────────────────────────────────────────────────────────────
// Allocates 20-port blocks for agent sub-processes.
// Each run gets one block; block indices are recycled when runs finish.

export class PortPool {
  private usedBlocks = new Set<number>()

  constructor(private basePort: number, private maxBlocks = 50) {}

  allocate(): number {
    for (let i = 0; i < this.maxBlocks; i++) {
      if (!this.usedBlocks.has(i)) {
        this.usedBlocks.add(i)
        return this.basePort + i * 20
      }
    }
    throw new Error(`No available port blocks (max ${this.maxBlocks} concurrent runs)`)
  }

  release(blockBasePort: number): void {
    const idx = (blockBasePort - this.basePort) / 20
    this.usedBlocks.delete(idx)
  }
}
