// Buddy 内存分配模拟器核心：纯内存态、确定性、可序列化。
// 阶(order)约定：块大小 = 2^order 字节。区域大小必须为 2^maxOrder。

export const MAX_ORDER_LIMIT = 30; // 区域最大 2^30 字节，保证 Number 精确整数
export const MAX_ALLOCATIONS = 1_000_000;

export type ErrCode =
  | 'INVALID_PARAM'
  | 'OUT_OF_MEMORY'
  | 'ALLOC_NOT_FOUND'
  | 'DUPLICATE_REQUEST'
  | 'LIMIT_EXCEEDED';

export class BuddyError extends Error {
  code: ErrCode;
  detail?: unknown;
  constructor(code: ErrCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export interface Step {
  action: 'split' | 'merge' | 'take-block' | 'free-block';
  order: number;
  offset: number;
  size: number;
  note?: string;
}

export interface AllocRecord {
  requestId: string;
  offset: number;
  size: number; // 实际占用（2 的幂）
  reqSize: number; // 申请字节数
  order: number;
}

export interface Block {
  offset: number;
  size: number;
}

export interface AllocResult {
  requestId: string;
  offset: number;
  size: number;
  reqSize: number;
  internalFrag: number;
  steps: Step[];
}

export interface FreeResult {
  requestId: string;
  offset: number;
  size: number;
  steps: Step[];
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
  readonly size: number;
  readonly minOrder: number;
  readonly maxOrder: number;
  // order -> 升序偏移数组
  private freeLists: Map<number, number[]> = new Map();
  private allocations: Map<string, AllocRecord> = new Map();

  constructor(size: number, minOrder = 0) {
    if (!Number.isSafeInteger(size) || !isPowerOfTwo(size)) {
      throw new BuddyError('INVALID_PARAM', '区域大小必须为 2 的整数次幂');
    }
    const maxOrder = log2(size);
    if (maxOrder > MAX_ORDER_LIMIT) {
      throw new BuddyError('INVALID_PARAM', `区域过大：最大允许 2^${MAX_ORDER_LIMIT} 字节`);
    }
    if (!Number.isInteger(minOrder) || minOrder < 0 || minOrder > maxOrder) {
      throw new BuddyError('INVALID_PARAM', `minOrder 必须在 [0, ${maxOrder}] 内`);
    }
    this.size = size;
    this.minOrder = minOrder;
    this.maxOrder = maxOrder;
    this.freeLists.set(maxOrder, [0]);
  }

  static deserialize(
    size: number,
    minOrder: number,
    free: Block[],
    allocs: AllocRecord[],
  ): BuddyAllocator {
    const a = new BuddyAllocator(size, minOrder);
    a.freeLists = new Map();
    for (const b of free) {
      const o = log2(b.size);
      if (!a.freeLists.has(o)) a.freeLists.set(o, []);
      a.freeLists.get(o)!.push(b.offset);
    }
    for (const arr of a.freeLists.values()) arr.sort((x, y) => x - y);
    a.allocations = new Map(allocs.map((r) => [r.requestId, { ...r }]));
    return a;
  }

  freeBlocks(): Block[] {
    const out: Block[] = [];
    for (const [order, offsets] of this.freeLists) {
      for (const offset of offsets) out.push({ offset, size: 2 ** order });
    }
    return out.sort((a, b) => a.offset - b.offset);
  }

  allocRecords(): AllocRecord[] {
    return [...this.allocations.values()].sort((a, b) => a.offset - b.offset);
  }

  allocationCount(): number {
    return this.allocations.size;
  }

  maxFreeBlock(): number {
    let max = 0;
    for (const [order, offsets] of this.freeLists) {
      if (offsets.length > 0 && 2 ** order > max) max = 2 ** order;
    }
    return max;
  }

  totalFree(): number {
    let sum = 0;
    for (const [order, offsets] of this.freeLists) sum += offsets.length * 2 ** order;
    return sum;
  }

  allocate(requestId: string, reqSize: number): AllocResult {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      throw new BuddyError('INVALID_PARAM', 'requestId 必须为 1-128 字符的字符串');
    }
    if (!Number.isSafeInteger(reqSize) || reqSize <= 0) {
      throw new BuddyError('INVALID_PARAM', '申请字节数必须为正整数（拒绝 0、小数、非安全整数）');
    }
    if (this.allocations.has(requestId)) {
      throw new BuddyError('DUPLICATE_REQUEST', `请求编号已存在: ${requestId}`);
    }
    if (this.allocations.size >= MAX_ALLOCATIONS) {
      throw new BuddyError('LIMIT_EXCEEDED', '分配数量达到上限');
    }
    const need = Math.max(nextPow2(reqSize), 2 ** this.minOrder);
    if (need > this.size) {
      throw new BuddyError('OUT_OF_MEMORY', `请求 ${reqSize} 字节（取整为 ${need}）超出区域大小 ${this.size}`, {
        maxFreeBlock: this.maxFreeBlock(),
      });
    }
    const needOrder = log2(need);
    // 找满足请求的最小可用阶
    let order = -1;
    for (let o = needOrder; o <= this.maxOrder; o++) {
      const list = this.freeLists.get(o);
      if (list && list.length > 0) {
        order = o;
        break;
      }
    }
    if (order === -1) {
      throw new BuddyError(
        'OUT_OF_MEMORY',
        `空闲总量 ${this.totalFree()} 字节足够，但缺少 >= ${need} 字节的连续空闲块`,
        { maxFreeBlock: this.maxFreeBlock(), totalFree: this.totalFree(), required: need },
      );
    }
    const steps: Step[] = [];
    // 候选中偏移最小者（数组升序，取头部）
    const offset = this.freeLists.get(order)!.shift()!;
    let curOrder = order;
    let curOffset = offset;
    steps.push({ action: 'take-block', order: curOrder, offset: curOffset, size: 2 ** curOrder });
    // 对半拆分，低地址半块继续用于本次申请
    while (curOrder > needOrder) {
      const half = 2 ** (curOrder - 1);
      const buddyOffset = curOffset + half;
      this.insertFree(curOrder - 1, buddyOffset);
      steps.push({
        action: 'split',
        order: curOrder,
        offset: curOffset,
        size: 2 ** curOrder,
        note: `拆为 [${curOffset},+${half}) 与 [${buddyOffset},+${half})，使用低地址半块`,
      });
      curOrder--;
    }
    const rec: AllocRecord = {
      requestId,
      offset: curOffset,
      size: need,
      reqSize,
      order: needOrder,
    };
    this.allocations.set(requestId, rec);
    return {
      requestId,
      offset: curOffset,
      size: need,
      reqSize,
      internalFrag: need - reqSize,
      steps,
    };
  }

  free(requestId: string): FreeResult {
    const rec = this.allocations.get(requestId);
    if (!rec) {
      throw new BuddyError('ALLOC_NOT_FOUND', `未知或已释放的分配编号: ${requestId}`);
    }
    this.allocations.delete(requestId);
    const steps: Step[] = [];
    steps.push({ action: 'free-block', order: rec.order, offset: rec.offset, size: rec.size });
    let order = rec.order;
    let offset = rec.offset;
    // 仅当同阶伙伴空闲时递归合并；伙伴偏移 = offset XOR size
    while (order < this.maxOrder) {
      const size = 2 ** order;
      const buddyOffset = offset ^ size;
      const list = this.freeLists.get(order);
      const idx = list ? list.indexOf(buddyOffset) : -1;
      if (idx === -1) break;
      list!.splice(idx, 1);
      offset = Math.min(offset, buddyOffset);
      order++;
      steps.push({
        action: 'merge',
        order,
        offset,
        size: 2 ** order,
        note: `与伙伴 [${buddyOffset},+${size}) 合并为 [${offset},+${2 ** order})`,
      });
    }
    this.insertFree(order, offset);
    return { requestId, offset, size: 2 ** order, steps };
  }

  private insertFree(order: number, offset: number): void {
    if (!this.freeLists.has(order)) this.freeLists.set(order, []);
    const list = this.freeLists.get(order)!;
    let i = 0;
    while (i < list.length && list[i] < offset) i++;
    list.splice(i, 0, offset);
  }

  lookup(offset: number): { kind: 'free' | 'allocated'; block: Block; alloc?: AllocRecord } {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.size) {
      throw new BuddyError('INVALID_PARAM', `偏移必须在 [0, ${this.size}) 内`);
    }
    for (const rec of this.allocations.values()) {
      if (offset >= rec.offset && offset < rec.offset + rec.size) {
        return { kind: 'allocated', block: { offset: rec.offset, size: rec.size }, alloc: { ...rec } };
      }
    }
    for (const b of this.freeBlocks()) {
      if (offset >= b.offset && offset < b.offset + b.size) return { kind: 'free', block: b };
    }
    // 状态合法时不可达
    throw new BuddyError('INVALID_PARAM', '内部状态不一致：偏移不属于任何块');
  }
}

export interface VerifyIssue {
  rule: string;
  detail: string;
}

// 独立不变量核验：仅从块清单重新计算，不信任操作返回值。
export function verifyState(
  regionSize: number,
  minOrder: number,
  free: Block[],
  allocs: Block[],
): { ok: boolean; issues: VerifyIssue[] } {
  const issues: VerifyIssue[] = [];
  const blocks = [
    ...free.map((b) => ({ ...b, free: true })),
    ...allocs.map((b) => ({ ...b, free: false })),
  ];
  for (const b of blocks) {
    if (!isPowerOfTwo(b.size)) {
      issues.push({ rule: 'SIZE_POW2', detail: `块大小 ${b.size} 不是 2 的幂 (offset=${b.offset})` });
      continue;
    }
    if (log2(b.size) < minOrder) {
      issues.push({ rule: 'MIN_ORDER', detail: `块小于最小阶 (offset=${b.offset}, size=${b.size})` });
    }
    if (b.offset % b.size !== 0) {
      issues.push({ rule: 'ALIGN', detail: `偏移 ${b.offset} 未按块大小 ${b.size} 对齐` });
    }
    if (b.offset < 0 || b.offset + b.size > regionSize) {
      issues.push({ rule: 'BOUNDS', detail: `块 [${b.offset},+${b.size}) 超出区域 [0,${regionSize})` });
    }
  }
  const sorted = [...blocks].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const b of sorted) {
    if (b.offset !== cursor) {
      issues.push({
        rule: b.offset < cursor ? 'OVERLAP' : 'COVERAGE',
        detail: `期望起始 ${cursor}，实际块起始 ${b.offset}（${b.offset < cursor ? '重叠' : '空洞'}）`,
      });
    }
    cursor = Math.max(cursor, b.offset + b.size);
  }
  if (cursor !== regionSize) {
    issues.push({ rule: 'COVERAGE', detail: `覆盖到 ${cursor}，区域大小 ${regionSize}` });
  }
  // 释放完成后不残留可合并的空闲伙伴
  const freeSet = new Set(free.map((b) => `${b.offset}:${b.size}`));
  for (const b of free) {
    const buddyOffset = b.offset ^ b.size;
    if (freeSet.has(`${buddyOffset}:${b.size}`)) {
      issues.push({
        rule: 'MERGEABLE_BUDDY',
        detail: `空闲块 [${b.offset},+${b.size}) 与伙伴 [${buddyOffset},+${b.size}) 仍可合并`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}
