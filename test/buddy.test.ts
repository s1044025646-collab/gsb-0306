import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuddyAllocator, BuddyError } from '../src/buddy';
import { verifyInvariants, byteMap } from '../src/invariant';
import { Store } from '../src/store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-test-'));
}

function check(a: BuddyAllocator) {
  const s = a.snapshot();
  const r = verifyInvariants(a.totalSize, s.freeBlocks, s.allocations);
  assert.ok(r.ok, r.violations.join('; '));
}

test('申请取整到二次幂并报告内部碎片', () => {
  const a = new BuddyAllocator(16);
  const { alloc } = a.allocate('a', 3);
  assert.equal(alloc.size, 4);
  assert.equal(alloc.size - alloc.requested, 1);
  assert.equal(alloc.offset, 0);
  check(a);
});

test('同阶多候选选偏移最小者，拆分用低地址半块', () => {
  const a = new BuddyAllocator(16);
  a.allocate('x', 4); // [0,4)
  a.allocate('y', 4); // [4,8)
  a.release('x');     // 空闲 [0,4) 与 [8,16)
  const { alloc } = a.allocate('z', 4);
  assert.equal(alloc.offset, 0);
  check(a);
});

test('相邻但非伙伴的同大小块不能合并', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 2); // 0
  a.allocate('b', 2); // 2
  a.allocate('c', 2); // 4
  a.allocate('d', 2); // 6
  a.release('b'); // 空闲 @2，伙伴 @0 被占用
  a.release('c'); // 空闲 @4，伙伴 @6 被占用
  const s = a.snapshot();
  const small = s.freeBlocks.filter((b) => b.order === 1);
  assert.equal(small.length, 2); // @2 与 @4 相邻但不是伙伴，不得合并
  check(a);
});

test('跨多阶递归合并，最终恢复为一个最大块', () => {
  const a = new BuddyAllocator(16);
  for (const id of ['a', 'b', 'c', 'd']) a.allocate(id, 4);
  a.release('a');
  a.release('b'); // 合并为 [0,8)
  a.release('d');
  const { steps } = a.release('c'); // 与 [12,16) 合并，再与 [0,8) 合并
  assert.equal(steps.filter((s) => s.action === 'merge').length, 2);
  const s = a.snapshot();
  assert.deepEqual(s.freeBlocks, [{ offset: 0, order: 4 }]);
  assert.equal(s.allocations.length, 0);
  check(a);
});

test('全满后申请失败并报告最大空闲块', () => {
  const a = new BuddyAllocator(16);
  a.allocate('big', 16);
  assert.throws(() => a.allocate('x', 1), (e: BuddyError) =>
    e.code === 'NO_CONTIGUOUS_BLOCK' && (e.detail as { maxFreeBlock: number }).maxFreeBlock === 0);
  check(a);
});

test('空闲总量足够但连续块不足时失败，报告最大空闲块', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 4); a.allocate('b', 4); a.allocate('c', 4); a.allocate('d', 4);
  a.release('a'); a.release('c'); // 空闲共 8B，但最大连续块 4B（互非伙伴）
  assert.equal(a.totalFree(), 8);
  assert.throws(() => a.allocate('x', 5), (e: BuddyError) =>
    e.code === 'NO_CONTIGUOUS_BLOCK' && (e.detail as { maxFreeBlock: number }).maxFreeBlock === 4);
  check(a);
});

test('失败申请不改变状态，编号可复用', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 8);
  const before = JSON.stringify(a.snapshot());
  assert.throws(() => a.allocate('bad', 0), (e: BuddyError) => e.code === 'INVALID_SIZE');
  assert.throws(() => a.allocate('bad', 1.5), (e: BuddyError) => e.code === 'INVALID_SIZE');
  assert.throws(() => a.allocate('bad', 32), (e: BuddyError) => e.code === 'REQUEST_EXCEEDS_REGION');
  assert.throws(() => a.allocate('a', 1), (e: BuddyError) => e.code === 'DUPLICATE_REQUEST_ID');
  assert.equal(JSON.stringify(a.snapshot()), before);
  a.allocate('bad', 4); // 失败编号未占用
  check(a);
});

test('未知编号与重复释放明确拒绝', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 4);
  a.release('a');
  assert.throws(() => a.release('a'), (e: BuddyError) => e.code === 'UNKNOWN_REQUEST_ID');
  assert.throws(() => a.release('nope'), (e: BuddyError) => e.code === 'UNKNOWN_REQUEST_ID');
});

test('非法区域大小拒绝', () => {
  assert.throws(() => new BuddyAllocator(0));
  assert.throws(() => new BuddyAllocator(24));
  assert.throws(() => new BuddyAllocator(2 ** 31));
});

test('逐字节占用图核对覆盖与不重叠', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 3); a.allocate('b', 1); a.allocate('c', 5);
  const s = a.snapshot();
  const map = byteMap(16, s.freeBlocks, s.allocations);
  assert.equal(map.length, 16);
  assert.ok(map.every((c) => c !== '?'));
  const owned = map.filter((c) => c === 'a').length;
  assert.equal(owned, 4);
  check(a);
});

test('地址查询区分分配与空闲', () => {
  const a = new BuddyAllocator(16);
  a.allocate('a', 4); // [0,4)
  assert.equal(a.queryAddress(2).kind, 'allocation');
  assert.equal(a.queryAddress(8).kind, 'free');
  assert.throws(() => a.queryAddress(16), (e: BuddyError) => e.code === 'INVALID_OFFSET');
  assert.throws(() => a.queryAddress(-1), (e: BuddyError) => e.code === 'INVALID_OFFSET');
});

test('多组固定操作序列每步不变量成立', () => {
  const sequences: Array<Array<[string, string, number?]>> = [
    [['alloc', 'a', 3], ['alloc', 'b', 3], ['alloc', 'c', 5], ['free', 'a'], ['free', 'b'], ['free', 'c']],
    [['alloc', 'a', 1], ['alloc', 'b', 2], ['free', 'a'], ['alloc', 'c', 8], ['free', 'b'], ['free', 'c']],
    [['alloc', 'a', 16], ['free', 'a'], ['alloc', 'b', 7], ['free', 'b']],
    [['alloc', 'a', 4], ['alloc', 'b', 4], ['free', 'a'], ['free', 'b'], ['alloc', 'c', 8], ['free', 'c']],
  ];
  for (const seq of sequences) {
    const a = new BuddyAllocator(16);
    for (const [op, id, bytes] of seq) {
      if (op === 'alloc') a.allocate(id, bytes!);
      else a.release(id);
      check(a);
    }
  }
});

test('SQLite 持久化：重启后状态与历史保留，可继续释放', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const r = store.createRegion(16, 't');
  store.applyOperation(r.id, (a) => ({ type: 'allocate', requestId: 'x', ...a.allocate('x', 3) }));
  store.applyOperation(r.id, (a) => ({ type: 'allocate', requestId: 'y', ...a.allocate('y', 5) }));
  store.close();

  const store2 = new Store(dir);
  const snap = store2.loadSnapshot(r.id);
  assert.equal(snap.allocations.length, 2);
  store2.applyOperation(r.id, (a) => ({ type: 'free', requestId: 'x', ...a.release('x') }));
  store2.applyOperation(r.id, (a) => ({ type: 'free', requestId: 'y', ...a.release('y') }));
  const after = store2.loadSnapshot(r.id);
  assert.deepEqual(after.freeBlocks, [{ offset: 0, order: 4 }]);
  assert.equal(store2.listEvents(r.id).length, 4);
  assert.ok(store2.verify(r.id).ok);
  store2.close();
});

test('历史快照不可变：后续释放不改写之前事件的前后状态', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const r = store.createRegion(16);
  store.applyOperation(r.id, (a) => ({ type: 'allocate', requestId: 'x', ...a.allocate('x', 4) }));
  const ev1Before = store.getEvent(r.id, 1);
  store.applyOperation(r.id, (a) => ({ type: 'free', requestId: 'x', ...a.release('x') }));
  const ev1After = store.getEvent(r.id, 1);
  assert.equal(ev1Before.after, ev1After.after);
  assert.equal(ev1Before.before, ev1After.before);
  // 回放：第 1 步之后 x 仍占用
  const replay = store.replay(r.id, 1);
  assert.equal(replay.state.allocations.length, 1);
  const replayAll = store.replay(r.id);
  assert.equal(replayAll.state.allocations.length, 0);
  store.close();
});

test('失败操作不落库：事件数与状态不变', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const r = store.createRegion(16);
  store.applyOperation(r.id, (a) => ({ type: 'allocate', requestId: 'x', ...a.allocate('x', 16) }));
  const before = JSON.stringify(store.loadSnapshot(r.id));
  assert.throws(() =>
    store.applyOperation(r.id, (a) => ({ type: 'allocate', requestId: 'y', ...a.allocate('y', 1) })),
    (e: BuddyError) => e.code === 'NO_CONTIGUOUS_BLOCK');
  assert.equal(JSON.stringify(store.loadSnapshot(r.id)), before);
  assert.equal(store.listEvents(r.id).length, 1);
  store.close();
});

test('多区域编号与地址空间独立', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const r1 = store.createRegion(16);
  const r2 = store.createRegion(32);
  store.applyOperation(r1.id, (a) => ({ type: 'allocate', requestId: 'same', ...a.allocate('same', 4) }));
  store.applyOperation(r2.id, (a) => ({ type: 'allocate', requestId: 'same', ...a.allocate('same', 4) }));
  assert.equal(store.listEvents(r1.id).length, 1);
  assert.equal(store.listEvents(r2.id).length, 1);
  store.close();
});
