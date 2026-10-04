// 演示：16 字节区域，连续申请 3B、3B、5B，改变释放顺序，
// 展示局部合并与最终恢复；中途模拟重启并继续释放。
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Store } from './store';
import { Snapshot } from './buddy';

const DEMO_DIR = path.join(process.cwd(), 'data-demo');

function show(title: string, totalSize: number, snap: Snapshot): void {
  const cells = new Array<string>(totalSize).fill('.');
  for (const a of snap.allocations) {
    for (let i = 0; i < a.size; i++) cells[a.offset + i] = a.requestId.slice(0, 1).toUpperCase();
  }
  console.log(`${title}\n  |${cells.join('')}|  (.=空闲)`);
}

function scenario(store: Store, regionId: number, freeOrder: string[], label: string): void {
  console.log(`\n=== ${label} ===`);
  const total = 16;
  const allocs: Array<[string, number]> = [['a', 3], ['b', 3], ['c', 5]];
  for (const [id, bytes] of allocs) {
    const { result, event } = store.applyOperation(regionId, (al) => ({
      type: 'allocate', requestId: id, ...al.allocate(id, bytes),
    }));
    const a = result.alloc!;
    console.log(`alloc ${id}(${bytes}B) -> offset ${a.offset}, size ${a.size}B, frag ${a.size - a.requested}B [event#${event.seq}]`);
    show('  state', total, store.loadSnapshot(regionId));
  }
  for (const id of freeOrder) {
    const { result, event } = store.applyOperation(regionId, (al) => ({
      type: 'free', requestId: id, ...al.release(id),
    }));
    const merges = result.steps.filter((s) => s.action === 'merge').length;
    console.log(`free ${id} -> merged ${merges} time(s) [event#${event.seq}]`);
    show('  state', total, store.loadSnapshot(regionId));
  }
  const v = store.verify(regionId);
  console.log(`invariant: ${v.ok ? 'OK' : 'FAIL ' + v.violations.join('; ')}`);
}

function main(): void {
  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  const store = new Store(DEMO_DIR);

  const r1 = store.createRegion(16, 'demo-order1');
  scenario(store, r1.id, ['a', 'b', 'c'], 'free order a -> b -> c');

  const r2 = store.createRegion(16, 'demo-order2');
  scenario(store, r2.id, ['c', 'b', 'a'], 'free order c -> b -> a');

  console.log('\n=== restart demo ===');
  const r3 = store.createRegion(16, 'demo-restart');
  const allocs: Array<[string, number]> = [['x', 3], ['y', 3], ['z', 5]];
  for (const [id, bytes] of allocs) {
    store.applyOperation(r3.id, (al) => ({ type: 'allocate', requestId: id, ...al.allocate(id, bytes) }));
  }
  store.applyOperation(r3.id, (al) => ({ type: 'free', requestId: 'x', ...al.release('x') }));
  show('before close', 16, store.loadSnapshot(r3.id));
  store.close();
  console.log('(database closed, simulating restart)');
  const store2 = new Store(DEMO_DIR);
  store2.applyOperation(r3.id, (al) => ({ type: 'free', requestId: 'y', ...al.release('y') }));
  store2.applyOperation(r3.id, (al) => ({ type: 'free', requestId: 'z', ...al.release('z') }));
  show('after restart + free all', 16, store2.loadSnapshot(r3.id));
  const v = store2.verify(r3.id);
  const snap = store2.loadSnapshot(r3.id);
  console.log(`invariant: ${v.ok ? 'OK' : 'FAIL'}; freeBlocks: ${JSON.stringify(snap.freeBlocks)}`);
  console.log(`events kept after restart: ${store2.listEvents(r3.id).length}`);
  store2.close();
}

main();
