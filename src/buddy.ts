// Buddy 内存分配模拟器核心：二分拆块 + 同阶伙伴递归合并。
// 只模拟地址与元数据，不分配真实内存。

export interface Block {
  offset: number;
  order: number; // 块大小 = 2^order 字节
}

export interface Allocation {
  requestId: string;
  offset: number;
  order: number;
  size: number;      // 实际占用 = 2^order
  requested: number; // 请求字节数
}

export interface Step {
  action: 'split' | 'merge' | 'allocate' | 'free';
  offset: number;
  order: number;
  note?: string;
}

export interface Snapshot {
  freeBlocks: Block[];
  allocations: Allocation[];
}

export const MAX_ORDER_LIMIT = 30; // 区域最大 2^30 字节
export const MAX_ALLOCATIONS_PER_REGION = 100000;

export class BuddyError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function log2(n: number): number {
  return Math.round(Math.log2(n));
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export class BuddyAllocator {
  readonly totalSize: number;
  readonly maxOrder: number;
  // 每阶空闲块偏移集合
  private free: Map<number, Set<number>> = new Map();
  private allocs: Map<string, Allocation> = new Map();

  constructor(totalSize: number) {
    if (!Number.isInteger(totalSize) || !isPowerOfTwo(totalSize)) {
      throw new BuddyError('INVALID_REGION_SIZE', '区域大小必须是 2 的整数次幂');
    }
    const order = log2(totalSize);
    if (order > MAX_ORDER_LIMIT) {
      throw new BuddyError('REGION_TOO_LARGE', `阶数超过上限 ${MAX_ORDER_LIMIT}`);
    }
    this.totalSize = totalSize;
    this.maxOrder = order;
    this.free.set(order, new Set([0]));
  }

  static fromSnapshot(totalSize: number, snap: Snapshot): BuddyAllocator {
    const a = new BuddyAllocator(totalSize);
    a.free.clear();
    for (const b of snap.freeBlocks) {
      if (!a.free.has(b.order)) a.free.set(b.order, new Set());
      a.free.get(b.order)!.add(b.offset);
    }
    a.allocs.clear();
    for (const al of snap.allocations) a.allocs.set(al.requestId, { ...al });
    return a;
  }

  snapshot(): Snapshot {
    const freeBlocks: Block[] = [];
    for (const [order, set] of this.free) {
      for (const offset of set) freeBlocks.push({ offset, order });
    }
    freeBlocks.sort((x, y) => x.offset - y.offset || x.order - y.order);
    const allocations = [...this.allocs.values()].sort((x, y) => x.offset - y.offset);
    return { freeBlocks, allocations };
  }

  has(requestId: string): boolean {
    return this.allocs.has(requestId);
  }

  allocationCount(): number {
    return this.allocs.size;
  }

  maxFreeBlockSize(): number {
    let max = 0;
    for (const [order, set] of this.free) {
      if (set.size > 0 && order > max) max = order;
    }
    return max === 0 && !this.free.get(0)?.size ? 0 : 2 ** max;
  }

  totalFree(): number {
    let sum = 0;
    for (const [order, set] of this.free) sum += set.size * 2 ** order;
    return sum;
  }

  allocate(requestId: string, bytes: number): { alloc: Allocation; steps: Step[] } {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      throw new BuddyError('INVALID_REQUEST_ID', '请求编号必须是非空字符串（<=128 字符）');
    }
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new BuddyError('INVALID_SIZE', '申请字节数必须是正整数（拒绝 0、小数、负数）');
    }
    if (this.allocs.has(requestId)) {
      throw new BuddyError('DUPLICATE_REQUEST_ID', `请求编号已存在: ${requestId}`);
    }
    if (this.allocs.size >= MAX_ALLOCATIONS_PER_REGION) {
      throw new BuddyError('TOO_MANY_ALLOCATIONS', '超出单区域请求数量上限');
    }
    const size = nextPow2(bytes);
    if (size > this.totalSize) {
      throw new BuddyError('REQUEST_EXCEEDS_REGION', `请求 ${bytes} 字节（取整为 ${size}）超出区域大小 ${this.totalSize}`, {
        maxFreeBlock: this.maxFreeBlockSize(),
      });
    }
    const needOrder = log2(size);
    // 找满足请求的最小可用阶
    let order = -1;
    for (let o = needOrder; o <= this.maxOrder; o++) {
      if ((this.free.get(o)?.size ?? 0) > 0) { order = o; break; }
    }
    if (order === -1) {
      throw new BuddyError('NO_CONTIGUOUS_BLOCK',
        `空闲总量 ${this.totalFree()} 字节足够与否不论，缺少 >= ${size} 字节的连续空闲块`,
        { maxFreeBlock: this.maxFreeBlockSize(), requested: size });
    }
    const steps: Step[] = [];
    // 候选中取偏移最小者
    const offset = Math.min(...this.free.get(order)!);
    this.free.get(order)!.delete(offset);
    // 逐层对半拆分，低地址半块继续用于本次申请
    while (order > needOrder) {
      const halfOrder = order - 1;
      const buddyOffset = offset + 2 ** halfOrder;
      if (!this.free.has(halfOrder)) this.free.set(halfOrder, new Set());
      this.free.get(halfOrder)!.add(buddyOffset);
      steps.push({ action: 'split', offset, order, note: `拆出伙伴 [${buddyOffset}, ${buddyOffset + 2 ** halfOrder})` });
      order = halfOrder;
    }
    const alloc: Allocation = {
      requestId, offset, order, size: 2 ** order, requested: bytes,
    };
    this.allocs.set(requestId, alloc);
    steps.push({ action: 'allocate', offset, order, note: `请求 ${bytes} 字节，实际 ${alloc.size}，内部碎片 ${alloc.size - bytes}` });
    return { alloc, steps };
  }

  release(requestId: string): { alloc: Allocation; steps: Step[] } {
    const alloc = this.allocs.get(requestId);
    if (!alloc) {
      throw new BuddyError('UNKNOWN_REQUEST_ID', `未知或已释放的请求编号: ${requestId}`);
    }
    this.allocs.delete(requestId);
    const steps: Step[] = [];
    steps.push({ action: 'free', offset: alloc.offset, order: alloc.order });
    let { offset, order } = alloc;
    // 同阶伙伴递归合并：伙伴偏移 = offset XOR size
    while (order < this.maxOrder) {
      const size = 2 ** order;
      const buddyOffset = offset ^ size;
      const set = this.free.get(order);
      if (!set || !set.has(buddyOffset)) break;
      set.delete(buddyOffset);
      offset = Math.min(offset, buddyOffset);
      order += 1;
      steps.push({ action: 'merge', offset, order, note: `与伙伴 [${buddyOffset}, ${buddyOffset + size}) 合并` });
    }
    if (!this.free.has(order)) this.free.set(order, new Set());
    this.free.get(order)!.add(offset);
    return { alloc, steps };
  }

  // 查询某个偏移属于哪项分配或哪块空闲区
  queryAddress(offset: number):
    | { kind: 'allocation'; allocation: Allocation }
    | { kind: 'free'; block: Block } {
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.totalSize) {
      throw new BuddyError('INVALID_OFFSET', `偏移必须是 [0, ${this.totalSize}) 内的整数`);
    }
    for (const a of this.allocs.values()) {
      if (offset >= a.offset && offset < a.offset + a.size) {
        return { kind: 'allocation', allocation: { ...a } };
      }
    }
    for (const [order, set] of this.free) {
      const size = 2 ** order;
      for (const o of set) {
        if (offset >= o && offset < o + size) return { kind: 'free', block: { offset: o, order } };
      }
    }
    // 不变量保证不会走到这里
    throw new BuddyError('INTERNAL', '地址未被任何块覆盖（不变量破坏）');
  }
}
