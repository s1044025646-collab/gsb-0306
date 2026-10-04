// 演示：16 字节区域，连续申请 3、3、5 字节，改变释放顺序，展示局部合并与最终恢复；
// 并演示“重启”（关闭并重开 Store）后继续释放。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderIntervalTable } from './render';
import { Store } from './store';

function show(store: Store, regionId: number, title: string): void {
  const s = store.state(regionId);
  console.log(`\n=== ${title} ===`);
  console.log(renderIntervalTable(s.region.size, s.free, s.allocations));
  console.log(`空闲总量 ${s.totalFree}, 最大空闲块 ${s.maxFreeBlock}`);
  const v = store.verify(regionId);
  console.log(`不变量核验: ${v.ok ? '通过' : '失败 ' + JSON.stringify(v.issues)}`);
}

function main(): void {
  const db = path.join(process.cwd(), 'data', 'demo.sqlite');
  fs.rmSync(db, { force: true });
  let store = new Store(db);

  console.log('--- 场景 A: 申请 3, 3, 5 字节后按相同顺序释放 ---');
  const regionA = store.createRegion(16);
  store.allocate(regionA.id, 'a1', 3);
  store.allocate(regionA.id, 'a2', 3);
  store.allocate(regionA.id, 'a3', 5);
  show(store, regionA.id, 'A: 已分配 a1(3B->4B@0), a2(3B->4B@4), a3(5B->8B@8)');
  store.free(regionA.id, 'a1');
  show(store, regionA.id, 'A: 释放 a1（伙伴 a2 仍占用，无法合并）');
  store.free(regionA.id, 'a2');
  show(store, regionA.id, 'A: 释放 a2（与伙伴 [0,4) 合并为 [0,8)）');
  store.free(regionA.id, 'a3');
  show(store, regionA.id, 'A: 释放 a3（跨阶合并恢复为单个 16 字节块）');

  console.log('\n--- 场景 B: 相同申请，改变释放顺序（先放中间） ---');
  const regionB = store.createRegion(16);
  store.allocate(regionB.id, 'b1', 3);
  store.allocate(regionB.id, 'b2', 3);
  store.allocate(regionB.id, 'b3', 5);
  show(store, regionB.id, 'B: 已分配 b1, b2, b3');
  store.free(regionB.id, 'b2');
  show(store, regionB.id, 'B: 先释放 b2（伙伴 b1 占用，不能合并）');
  store.free(regionB.id, 'b3');
  show(store, regionB.id, 'B: 再释放 b3（[8,16) 空闲，但 [4,8) 被 b1 拆散，无法跨阶合并）');

  console.log('\n--- 模拟进程重启：关闭并重开 Store，继续释放 b1 ---');
  store.close();
  store = new Store(db);
  show(store, regionB.id, 'B: 重启后状态（从 SQLite 恢复）');
  store.free(regionB.id, 'b1');
  show(store, regionB.id, 'B: 释放 b1（[0,4)+[4,8) -> [0,8)，再与 [8,16) 合并 -> 完整恢复）');

  console.log('\n--- 场景 C: 相邻但非伙伴，不能合并 ---');
  const regionC = store.createRegion(16);
  store.allocate(regionC.id, 'c1', 4); // [0,4)
  store.allocate(regionC.id, 'c2', 2); // [4,6)
  store.allocate(regionC.id, 'c3', 2); // [6,8)
  store.free(regionC.id, 'c2'); // [4,6) 空闲，伙伴 [6,8) 被占用
  store.free(regionC.id, 'c1'); // [0,4) 空闲，伙伴 [4,8) 不空闲（c3 占用）
  show(store, regionC.id, 'C: [0,4) 与 [4,6) 相邻但非伙伴，保持分离');
  store.close();
  console.log('\n演示完成。数据库: data/demo.sqlite');
}

main();
