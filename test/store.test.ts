import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/store';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-')), 'test.sqlite');
}

test('持久化与重启恢复', () => {
  const db = tmpDb();
  let store = new Store(db);
  const region = store.createRegion(16);
  store.allocate(region.id, 'p1', 3);
  store.allocate(region.id, 'p2', 5);
  store.close();

  store = new Store(db); // 模拟重启
  const s = store.state(region.id);
  assert.equal(s.allocations.length, 2);
  store.free(region.id, 'p1');
  store.free(region.id, 'p2');
  assert.deepEqual(store.state(region.id).free, [{ offset: 0, size: 16 }]);
  assert.ok(store.verify(region.id).ok);
  store.close();
});

test('事件快照不可被后续释放改写', () => {
  const db = tmpDb();
  const store = new Store(db);
  const region = store.createRegion(16);
  store.allocate(region.id, 'e1', 4);
  const before = store.events(region.id).find((e) => e.requestId === 'e1')!;
  const snapshotJson = JSON.stringify(before.stateAfter);
  store.free(region.id, 'e1');
  const after = store.events(region.id).find((e) => e.requestId === 'e1')!;
  assert.equal(JSON.stringify(after.stateAfter), snapshotJson, '历史快照不得被改写');
  // 回放应重现当时状态
  const replayed = store.replay(region.id, after.seq);
  assert.deepEqual(replayed[replayed.length - 1].state, after.stateAfter);
  store.close();
});

test('失败申请原子性：数据库状态与事件数不变', () => {
  const db = tmpDb();
  const store = new Store(db);
  const region = store.createRegion(16);
  store.allocate(region.id, 'x1', 8);
  store.allocate(region.id, 'x2', 8);
  const stateBefore = JSON.stringify(store.state(region.id));
  const eventsBefore = store.events(region.id).length;
  assert.throws(() => store.allocate(region.id, 'x3', 4));
  assert.equal(JSON.stringify(store.state(region.id)), stateBefore);
  assert.equal(store.events(region.id).length, eventsBefore);
  store.close();
});

test('多区域编号与地址空间独立', () => {
  const db = tmpDb();
  const store = new Store(db);
  const r1 = store.createRegion(16);
  const r2 = store.createRegion(64);
  store.allocate(r1.id, 'same-id', 4);
  store.allocate(r2.id, 'same-id', 4); // 不同区域允许相同编号
  assert.equal(store.state(r1.id).allocations[0].offset, 0);
  assert.equal(store.state(r2.id).allocations[0].offset, 0);
  store.close();
});

test('导出 JSON 包含区域、状态、核验与事件', () => {
  const db = tmpDb();
  const store = new Store(db);
  const region = store.createRegion(16);
  store.allocate(region.id, 'j1', 3);
  const data = store.exportJson(region.id);
  assert.equal(data.region.size, 16);
  assert.ok(data.verify.ok);
  assert.equal(data.events.length, 2); // create + alloc
  store.close();
});
