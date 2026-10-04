import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BuddyAllocator, BuddyError, verifyState } from '../src/buddy';

function checkInvariant(a: BuddyAllocator): void {
  const r = verifyState(
    a.size,
    a.minOrder,
    a.freeBlocks(),
    a.allocRecords().map((x) => ({ offset: x.offset, size: x.size })),
  );
  assert.ok(r.ok, JSON.stringify(r.issues));
}

// 逐字节独立占用图：每个字节恰好被覆盖一次
function checkByteMap(a: BuddyAllocator): void {
  const map = new Array<number>(a.size).fill(0);
  for (const b of [...a.freeBlocks(), ...a.allocRecords()]) {
    for (let i = b.offset; i < b.offset + b.size; i++) map[i]++;
  }
  assert.ok(map.every((c) => c === 1), '覆盖图必须每字节恰好一次');
}

test('申请取整到 2 的幂并报告内部碎片', () => {
  const a = new BuddyAllocator(16);
  const r = a.allocate('x', 3);
  assert.equal(r.size, 4);
  assert.equal(r.internalFrag, 1);
  assert.equal(r.offset, 0);
  checkInvariant(a);
  checkByteMap(a);
});

test('拆分时低地址半块优先，多个候选选最小偏移', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 4); // [0,4)
  a.allocate('b', 4); // [4,8)
  a.allocate('c', 8); // [8,16)
  a.free('b'); // [4,8) 空闲
  a.free('a'); // 合并回 [0,8)
  a.allocate('d', 4); // [0,4)
  a.free('d'); // [0,4) 空闲，候选 [0,4) 与 [4,8)
  const r = a.allocate('e', 4);
  assert.equal(r.offset, 0, '应选偏移最小候选');
  checkInvariant(a);
});

test('相邻非伙伴不合并', () => {
  const a = new BuddyAllocator(16);
  a.allocate('c1', 4); // [0,4)
  a.allocate('c2', 2); // [4,6)
  a.allocate('c3', 2); // [6,8)
  a.free('c2'); // [4,6) 空闲，伙伴 [6,8) 占用
  a.free('c1'); // [0,4) 空闲，伙伴 [4,8) 不空闲
  const free = a.freeBlocks();
  assert.ok(free.some((b) => b.offset === 0 && b.size === 4));
  assert.ok(free.some((b) => b.offset === 4 && b.size === 2));
  assert.ok(!free.some((b) => b.size === 8 && b.offset === 0), '不得错误合并');
  checkInvariant(a);
  checkByteMap(a);
});

test('跨多阶递归合并并完整恢复', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a1', 3);
  a.allocate('a2', 3);
  a.allocate('a3', 5);
  a.free('a1');
  a.free('a2');
  const r = a.free('a3');
  assert.equal(r.size, 16);
  assert.equal(r.offset, 0);
  assert.deepEqual(a.freeBlocks(), [{ offset: 0, size: 16 }]);
  checkInvariant(a);
});

test('全满后失败，报告最大空闲块，且状态不变', () => {
  const a = new BuddyAllocator(16);
  a.allocate('f1', 8);
  a.allocate('f2', 8);
  const before = JSON.stringify([a.freeBlocks(), a.allocRecords()]);
  assert.throws(() => a.allocate('f3', 1), (e: unknown) => {
    const err = e as BuddyError;
    assert.equal(err.code, 'OUT_OF_MEMORY');
    assert.equal((err.detail as { maxFreeBlock: number }).maxFreeBlock, 0);
    return true;
  });
  const after = JSON.stringify([a.freeBlocks(), a.allocRecords()]);
  assert.equal(before, after, '失败申请不得改变状态');
});

test('空闲总量足够但最大连续块不足时失败', () => {
  const a = new BuddyAllocator(16);
  a.allocate('g1', 4); // [0,4)
  a.allocate('g2', 4); // [4,8)
  a.allocate('g3', 4); // [8,12)
  a.allocate('g4', 4); // [12,16)
  a.free('g1');
  a.free('g3'); // 两个互不为伙伴的 4 字节空闲块
  assert.equal(a.totalFree(), 8);
  assert.throws(() => a.allocate('g5', 8), (e: unknown) => {
    const err = e as BuddyError;
    assert.equal(err.code, 'OUT_OF_MEMORY');
    assert.match(err.message, /连续/);
    assert.equal((err.detail as { maxFreeBlock: number }).maxFreeBlock, 4);
    return true;
  });
  checkInvariant(a);
});

test('未知编号与重复释放被拒绝', () => {
  const a = new BuddyAllocator(16);
  a.allocate('h1', 4);
  a.free('h1');
  assert.throws(() => a.free('h1'), /未知或已释放/);
  assert.throws(() => a.free('nope'), (e: unknown) => (e as BuddyError).code === 'ALLOC_NOT_FOUND');
});

test('重复请求编号被拒绝', () => {
  const a = new BuddyAllocator(16);
  a.allocate('dup', 4);
  assert.throws(() => a.allocate('dup', 4), (e: unknown) => (e as BuddyError).code === 'DUPLICATE_REQUEST');
});

test('非法参数校验：零长度、小数、超区域、非法区域', () => {
  const a = new BuddyAllocator(16);
  assert.throws(() => a.allocate('z', 0), /INVALID_PARAM|正整数/);
  assert.throws(() => a.allocate('z', 1.5), /INVALID_PARAM|正整数/);
  assert.throws(() => a.allocate('z', -3), /INVALID_PARAM|正整数/);
  assert.throws(() => a.allocate('z', 32), (e: unknown) => (e as BuddyError).code === 'OUT_OF_MEMORY');
  assert.throws(() => new BuddyAllocator(100), /2 的整数次幂/);
  assert.throws(() => new BuddyAllocator(2 ** 40), /区域过大/);
  assert.throws(() => a.lookup(16), (e: unknown) => (e as BuddyError).code === 'INVALID_PARAM');
  assert.throws(() => a.lookup(-1), (e: unknown) => (e as BuddyError).code === 'INVALID_PARAM');
});

test('lookup 查询偏移归属', () => {
  const a = new BuddyAllocator(16);
  a.allocate('k', 3); // [0,4)
  assert.equal(a.lookup(2).kind, 'allocated');
  assert.equal(a.lookup(2).alloc?.requestId, 'k');
  assert.equal(a.lookup(10).kind, 'free');
});

test('多组固定操作序列每步核验不变量与字节图', () => {
  const sequences: Array<Array<[string, string, number?]>> = [
    [
      ['alloc', 'r1', 1],
      ['alloc', 'r2', 2],
      ['alloc', 'r3', 3],
      ['free', 'r2'],
      ['alloc', 'r4', 1],
      ['free', 'r1'],
      ['free', 'r3'],
      ['free', 'r4'],
    ],
    [
      ['alloc', 's1', 8],
      ['alloc', 's2', 4],
      ['free', 's1'],
      ['alloc', 's3', 2],
      ['free', 's2'],
      ['free', 's3'],
    ],
    [
      ['alloc', 't1', 16],
      ['free', 't1'],
      ['alloc', 't2', 1],
      ['free', 't2'],
    ],
  ];
  for (const seq of sequences) {
    const a = new BuddyAllocator(16);
    for (const [op, id, bytes] of seq) {
      if (op === 'alloc') a.allocate(id, bytes!);
      else a.free(id);
      checkInvariant(a);
      checkByteMap(a);
    }
  }
  // 全部释放后恢复单块
  const a = new BuddyAllocator(16);
  a.allocate('q', 1);
  a.free('q');
  assert.deepEqual(a.freeBlocks(), [{ offset: 0, size: 16 }]);
});

test('序列化往返保持状态', () => {
  const a = new BuddyAllocator(64);
  a.allocate('m1', 5);
  a.allocate('m2', 9);
  a.allocate('m3', 1);
  a.free('m2');
  const b = BuddyAllocator.deserialize(64, 0, a.freeBlocks(), a.allocRecords());
  assert.deepEqual(b.freeBlocks(), a.freeBlocks());
  assert.deepEqual(b.allocRecords(), a.allocRecords());
  const r = b.allocate('m4', 5);
  assert.equal(r.offset, 16, '恢复后应复用 [16,32) 空闲块');
  checkInvariant(b);
});
