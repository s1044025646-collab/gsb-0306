// SQLite 持久化：块清单、分配记录与不可变事件历史，原子提交。
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { BuddyAllocator, Snapshot, Step, Allocation, BuddyError } from './buddy';
import { verifyInvariants } from './invariant';

export interface RegionRow {
  id: number;
  name: string;
  total_size: number;
  max_order: number;
  created_at: string;
}

export interface EventRow {
  seq: number;
  region_id: number;
  type: 'allocate' | 'free';
  request_id: string;
  detail: string;   // JSON: { steps, alloc? }
  before: string;   // JSON Snapshot，不可变
  after: string;    // JSON Snapshot，不可变
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'buddy.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS regions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        total_size INTEGER NOT NULL,
        max_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS free_blocks (
        region_id INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        ord INTEGER NOT NULL,
        PRIMARY KEY (region_id, offset, ord)
      );
      CREATE TABLE IF NOT EXISTS allocations (
        region_id INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        offset INTEGER NOT NULL,
        ord INTEGER NOT NULL,
        size INTEGER NOT NULL,
        requested INTEGER NOT NULL,
        PRIMARY KEY (region_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        region_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        request_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        before TEXT NOT NULL,
        after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (region_id, seq)
      );
    `);
  }

  close(): void { this.db.close(); }

  createRegion(totalSize: number, name = ''): RegionRow {
    const a = new BuddyAllocator(totalSize); // 校验
    const now = new Date().toISOString();
    const tx = this.db.prepare(
      'INSERT INTO regions (name, total_size, max_order, created_at) VALUES (?, ?, ?, ?)');
    const res = tx.run(name, totalSize, a.maxOrder, now);
    const id = Number(res.lastInsertRowid);
    this.saveSnapshot(id, a.snapshot());
    return this.getRegion(id);
  }

  listRegions(): RegionRow[] {
    return this.db.prepare('SELECT * FROM regions ORDER BY id').all() as unknown as RegionRow[];
  }

  getRegion(id: number): RegionRow {
    const row = this.db.prepare('SELECT * FROM regions WHERE id = ?').get(id) as unknown as RegionRow | undefined;
    if (!row) throw new BuddyError('REGION_NOT_FOUND', `区域不存在: ${id}`);
    return row;
  }

  loadSnapshot(regionId: number): Snapshot {
    this.getRegion(regionId);
    const freeRows = this.db.prepare(
      'SELECT offset, ord FROM free_blocks WHERE region_id = ? ORDER BY offset').all(regionId) as unknown as { offset: number; ord: number }[];
    const freeBlocks = freeRows.map((r) => ({ offset: Number(r.offset), order: Number(r.ord) }));
    const allocRows = this.db.prepare(
      'SELECT request_id, offset, ord, size, requested FROM allocations WHERE region_id = ? ORDER BY offset'
    ).all(regionId) as unknown as { request_id: string; offset: number; ord: number; size: number; requested: number }[];
    const allocations: Allocation[] = allocRows.map((r) => ({
      requestId: r.request_id, offset: Number(r.offset), order: Number(r.ord),
      size: Number(r.size), requested: Number(r.requested),
    }));
    return { freeBlocks, allocations };
  }

  loadAllocator(regionId: number): BuddyAllocator {
    const region = this.getRegion(regionId);
    return BuddyAllocator.fromSnapshot(Number(region.total_size), this.loadSnapshot(regionId));
  }

  private saveSnapshot(regionId: number, snap: Snapshot): void {
    this.db.prepare('DELETE FROM free_blocks WHERE region_id = ?').run(regionId);
    this.db.prepare('DELETE FROM allocations WHERE region_id = ?').run(regionId);
    const insFree = this.db.prepare('INSERT INTO free_blocks (region_id, offset, ord) VALUES (?, ?, ?)');
    for (const b of snap.freeBlocks) insFree.run(regionId, b.offset, b.order);
    const insAlloc = this.db.prepare(
      'INSERT INTO allocations (region_id, request_id, offset, ord, size, requested) VALUES (?, ?, ?, ?, ?, ?)');
    for (const a of snap.allocations) insAlloc.run(regionId, a.requestId, a.offset, a.order, a.size, a.requested);
  }

  // 原子执行一次操作：状态变更 + 事件追加在同一事务
  applyOperation(
    regionId: number,
    op: (alloc: BuddyAllocator) => { type: 'allocate' | 'free'; requestId: string; steps: Step[]; alloc?: Allocation },
  ): { event: EventRow; result: ReturnType<typeof op> } {
    const allocator = this.loadAllocator(regionId);
    const before = allocator.snapshot();
    const result = op(allocator); // 失败时抛错，不落库，状态不变
    const after = allocator.snapshot();
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      const seqRow = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE region_id = ?').get(regionId) as unknown as { seq: number };
      const seq = Number(seqRow.seq);
      this.db.prepare(
        'INSERT INTO events (region_id, seq, type, request_id, detail, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(regionId, seq, result.type, result.requestId,
        JSON.stringify({ steps: result.steps, alloc: result.alloc ?? null }),
        JSON.stringify(before), JSON.stringify(after), now);
      this.saveSnapshot(regionId, after);
      this.db.exec('COMMIT');
      return { event: this.getEvent(regionId, seq), result };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listEvents(regionId: number): EventRow[] {
    this.getRegion(regionId);
    return this.db.prepare('SELECT * FROM events WHERE region_id = ? ORDER BY seq').all(regionId) as unknown as EventRow[];
  }

  getEvent(regionId: number, seq: number): EventRow {
    const row = this.db.prepare(
      'SELECT * FROM events WHERE region_id = ? AND seq = ?').get(regionId, seq) as unknown as EventRow | undefined;
    if (!row) throw new BuddyError('EVENT_NOT_FOUND', `事件不存在: region=${regionId} seq=${seq}`);
    return row;
  }

  // 逐步回放：返回前 N 个事件及第 N 步之后的状态快照
  replay(regionId: number, toSeq?: number): { events: EventRow[]; state: Snapshot } {
    const events = this.listEvents(regionId);
    const limited = toSeq === undefined ? events : events.filter((e) => Number(e.seq) <= toSeq);
    const state: Snapshot = limited.length === 0
      ? { freeBlocks: [{ offset: 0, order: this.getRegion(regionId).max_order as number }], allocations: [] }
      : JSON.parse(limited[limited.length - 1].after);
    return { events: limited, state };
  }

  verify(regionId: number) {
    const region = this.getRegion(regionId);
    const snap = this.loadSnapshot(regionId);
    return verifyInvariants(Number(region.total_size), snap.freeBlocks, snap.allocations);
  }

  exportRegion(regionId: number) {
    return {
      region: this.getRegion(regionId),
      snapshot: this.loadSnapshot(regionId),
      events: this.listEvents(regionId),
      verify: this.verify(regionId),
    };
  }
}
