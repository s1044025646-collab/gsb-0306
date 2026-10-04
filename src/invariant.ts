// 独立不变量核验：从当前块清单重新计算，不信任操作返回值。
import { Block, Allocation, isPowerOfTwo, log2 } from './buddy';

export interface InvariantReport {
  ok: boolean;
  violations: string[];
}

export function verifyInvariants(
  totalSize: number,
  freeBlocks: Block[],
  allocations: Allocation[],
): InvariantReport {
  const violations: string[] = [];
  const maxOrder = log2(totalSize);

  interface Span { offset: number; size: number; kind: string }
  const spans: Span[] = [];
  for (const b of freeBlocks) spans.push({ offset: b.offset, size: 2 ** b.order, kind: 'free' });
  for (const a of allocations) spans.push({ offset: a.offset, size: a.size, kind: `alloc:${a.requestId}` });

  // 大小为二次幂且对齐
  for (const b of freeBlocks) {
    const size = 2 ** b.order;
    if (!isPowerOfTwo(size)) violations.push(`空闲块 @${b.offset} 大小非二次幂`);
    if (b.offset % size !== 0) violations.push(`空闲块 @${b.offset} 未按大小 ${size} 对齐`);
    if (b.order > maxOrder) violations.push(`空闲块 @${b.offset} 阶数超界`);
  }
  for (const a of allocations) {
    if (!isPowerOfTwo(a.size)) violations.push(`分配 ${a.requestId} 大小非二次幂`);
    if (a.offset % a.size !== 0) violations.push(`分配 ${a.requestId} @${a.offset} 未按大小 ${a.size} 对齐`);
    if (a.size !== 2 ** a.order) violations.push(`分配 ${a.requestId} 阶数与大小不一致`);
  }

  // 不重叠且完整覆盖 [0, totalSize)
  const sorted = [...spans].sort((x, y) => x.offset - y.offset);
  let cursor = 0;
  for (const s of sorted) {
    if (s.offset < cursor) violations.push(`块 ${s.kind} @${s.offset} 与前块重叠`);
    if (s.offset > cursor) violations.push(`区间 [${cursor}, ${s.offset}) 未被覆盖`);
    cursor = s.offset + s.size;
  }
  if (cursor !== totalSize) violations.push(`覆盖终点 ${cursor} != 区域大小 ${totalSize}`);

  // 释放完成后不残留可合并的空闲伙伴
  const freeSet = new Set(freeBlocks.map((b) => `${b.order}:${b.offset}`));
  for (const b of freeBlocks) {
    if (b.order >= maxOrder) continue;
    const buddy = b.offset ^ (2 ** b.order);
    if (freeSet.has(`${b.order}:${buddy}`)) {
      violations.push(`空闲块 @${b.offset} (order ${b.order}) 与伙伴 @${buddy} 仍可合并`);
    }
  }

  return { ok: violations.length === 0, violations };
}

// 逐字节占用图：小区域用，返回每个字节的归属
export function byteMap(
  totalSize: number,
  freeBlocks: Block[],
  allocations: Allocation[],
): string[] {
  const map = new Array<string>(totalSize).fill('?');
  for (const b of freeBlocks) {
    for (let i = 0; i < 2 ** b.order; i++) map[b.offset + i] = 'free';
  }
  for (const a of allocations) {
    for (let i = 0; i < a.size; i++) map[a.offset + i] = a.requestId;
  }
  return map;
}
