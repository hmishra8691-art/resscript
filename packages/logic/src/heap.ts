/**
 * A binary min-heap over cell indices — D §5.3.
 *
 * WHY a heap and not a queue: the dirty set must be processed in *topological* order
 * (`topoPos`), which guarantees two properties the incremental budget depends on — no cell is
 * recomputed from a stale input, and no cell is recomputed twice. A FIFO queue or a recursive
 * "recompute my dependents" walk revisits diamond-shaped dependencies exponentially, which is
 * the difference between 1 ms and 40 ms on a grid with 30 rows of option-state rules.
 *
 * WHY hand-written: this package has zero dependencies (ADR-004/ADR-010), and the heap is
 * thirty lines. It stores plain integers in a `number[]` so there is no per-push allocation
 * once the array has grown (D §10.3 bans steady-state allocation on this path).
 */

import { at } from './ids.js';

export class MinHeap {
  private readonly items: number[] = [];

  /** `key(item)` must be stable while the item is in the heap. */
  constructor(private readonly key: (item: number) => number) {}

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(item: number): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key(at(this.items, parent)) <= this.key(at(this.items, i))) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  /** `undefined` only when empty, so callers can loop on it without a second check. */
  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = at(this.items, 0);
    const last = this.items.pop();
    if (last === undefined || this.items.length === 0) return top;
    this.items[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.items.length && this.key(at(this.items, left)) < this.key(at(this.items, smallest))) {
        smallest = left;
      }
      if (right < this.items.length && this.key(at(this.items, right)) < this.key(at(this.items, smallest))) {
        smallest = right;
      }
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const tmp = at(this.items, a);
    this.items[a] = at(this.items, b);
    this.items[b] = tmp;
  }
}
