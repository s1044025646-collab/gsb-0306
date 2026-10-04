// 终端区间表渲染（ASCII，无绘图依赖）
import { AllocRecord, Block } from './buddy';

export function renderIntervalTable(
  regionSize: number,
  free: Block[],
  allocations: AllocRecord[],
): string {
  const rows: Array<{ offset: number; size: number; label: string }> = [];
  for (const b of free) rows.push({ offset: b.offset, size: b.size, label: 'FREE' });
  for (const a of allocations) {
    rows.push({
      offset: a.offset,
      size: a.size,
      label: `ALLOC ${a.requestId} (req=${a.reqSize}, frag=${a.size - a.reqSize})`,
    });
  }
  rows.sort((a, b) => a.offset - b.offset);
  const lines = [
    `区域 [0, ${regionSize}) 字节  阶约定: 块大小 = 2^order, 偏移按块大小对齐, 伙伴偏移 = offset XOR size`,
    '区间            | 大小   | 阶    | 状态',
    '----------------+--------+-------+--------------------------------',
  ];
  for (const r of rows) {
    const range = `[${String(r.offset).padStart(4)}, ${String(r.offset + r.size).padStart(4)})`;
    const order = Math.round(Math.log2(r.size));
    lines.push(
      `${range.padEnd(16)}| ${String(r.size).padStart(6)} | 2^${String(order).padEnd(2)} | ${r.label}`,
    );
  }
  return lines.join('\n');
}
