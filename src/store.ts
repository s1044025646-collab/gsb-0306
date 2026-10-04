// SQLite 持久化：区域、块清单、分配记录、不可变事件（含前后状态快照与步骤）。
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AllocRecord,
  AllocResult,
  Block,
  BuddyAllocator,
  BuddyError,
  FreeResult,
  Step,
  verifyState,
} from './buddy';

export interface RegionRow {
  id: number;
  size: number;
  minOrder: number;
  createdAt: string;
}

export interface EventRow {
  seq: number;
  type: 'create' | 'alloc' | 'free';
  requestId: string | null;
  steps: Step[];
  stateBefore: Snapshot;
  stateAfter: Snapshot;
  createdAt: string;
}

export interface Snapshot {
  free: Block[];
  allocations: AllocRecord[];
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS regions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        size INTEGER NOT NULL,
        min_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        region_id INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('free','alloc')),
        request_id TEXT,
        req_size INTEGER,
        PRIMARY KEY (region_id, offset)
      );
      CREATE TABLE IF NOT EXISTS events (
        region_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        request_id TEXT,
        steps TEXT NOT NULL,
        state_before TEXT NOT NULL,
        state_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (region_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private snapshot(regionId: number): Snapshot {
    const rows = this.db
      .prepare('SELECT offset, size, status, request_id, req_size FROM blocks WHERE region_id = ? ORDER BY offset')
      .all(regionId) as unknown as Array<{
      offset: number;
      size: number;
      status: string;
      request_id: string | null;
      req_size: number | null;
    }>;
    const free: Block[] = [];
    const allocations: AllocRecord[] = [];
    for (const r of rows) {
      if (r.status === 'free') {
        free.push({ offset: r.offset, size: r.size });
      } else {
        allocations.push({
          requestId: r.request_id!,
          offset: r.offset,
          size: r.size,
          reqSize: r.req_size!,
          order: Math.round(Math.log2(r.size)),
        });
      }
    }
    return { free, allocations };
  }

  private loadAllocator(regionId: number): BuddyAllocator {
    const region = this.getRegion(regionId);
    const snap = this.snapshot(regionId);
    return BuddyAllocator.deserialize(region.size, region.minOrder, snap.free, snap.allocations);
  }

  // 原子地用分配器当前状态重写块清单
  private persistBlocks(regionId: number, alloc: BuddyAllocator): void {
    this.db.prepare('DELETE FROM blocks WHERE region_id = ?').run(regionId);
    const ins = this.db.prepare(
      'INSERT INTO blocks (region_id, offset, size, status, request_id, req_size) VALUES (?,?,?,?,?,?)',
    );
    for (const b of alloc.freeBlocks()) ins.run(regionId, b.offset, b.size, 'free', null, null);
    for (const r of alloc.allocRecords()) ins.run(regionId, r.offset, r.size, 'alloc', r.requestId, r.reqSize);
  }

  private appendEvent(
    regionId: number,
    type: EventRow['type'],
    requestId: string | null,
    steps: Step[],
    before: Snapshot,
    after: Snapshot,
  ): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE region_id = ?')
      .get(regionId) as unknown as { seq: number };
    this.db
      .prepare(
        'INSERT INTO events (region_id, seq, type, request_id, steps, state_before, state_after, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        regionId,
        row.seq,
        type,
        requestId,
        JSON.stringify(steps),
        JSON.stringify(before),
        JSON.stringify(after),
        new Date().toISOString(),
      );
    return row.seq;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  createRegion(size: number, minOrder = 0): RegionRow {
    return this.tx(() => {
      // 校验参数
      const alloc = new BuddyAllocator(size, minOrder);
      const info = this.db
        .prepare('INSERT INTO regions (size, min_order, created_at) VALUES (?,?,?)')
        .run(size, minOrder, new Date().toISOString());
      const id = Number(info.lastInsertRowid);
      this.persistBlocks(id, alloc);
      this.appendEvent(id, 'create', null, [], { free: [], allocations: [] }, this.snapshot(id));
      return this.getRegion(id);
    });
  }

  getRegion(id: number): RegionRow {
    const r = this.db
      .prepare('SELECT id, size, min_order AS minOrder, created_at AS createdAt FROM regions WHERE id = ?')
      .get(id) as unknown as RegionRow | undefined;
    if (!r) throw new BuddyError('INVALID_PARAM', `区域不存在: ${id}`);
    return r;
  }

  listRegions(): RegionRow[] {
    return this.db
      .prepare('SELECT id, size, min_order AS minOrder, created_at AS createdAt FROM regions ORDER BY id')
      .all() as unknown as RegionRow[];
  }

  allocate(regionId: number, requestId: string, reqSize: number): AllocResult & { seq: number } {
    return this.tx(() => {
      const alloc = this.loadAllocator(regionId);
      const before = this.snapshot(regionId);
      const result = alloc.allocate(requestId, reqSize); // 失败时抛错 -> 回滚，状态不变
      this.persistBlocks(regionId, alloc);
      const after = this.snapshot(regionId);
      const seq = this.appendEvent(regionId, 'alloc', requestId, result.steps, before, after);
      return { ...result, seq };
    });
  }

  free(regionId: number, requestId: string): FreeResult & { seq: number } {
    return this.tx(() => {
      const alloc = this.loadAllocator(regionId);
      const before = this.snapshot(regionId);
      const result = alloc.free(requestId);
      this.persistBlocks(regionId, alloc);
      const after = this.snapshot(regionId);
      const seq = this.appendEvent(regionId, 'free', requestId, result.steps, before, after);
      return { ...result, seq };
    });
  }

  state(regionId: number): Snapshot & { region: RegionRow; totalFree: number; maxFreeBlock: number } {
    const region = this.getRegion(regionId);
    const alloc = this.loadAllocator(regionId);
    return {
      region,
      free: alloc.freeBlocks(),
      allocations: alloc.allocRecords(),
      totalFree: alloc.totalFree(),
      maxFreeBlock: alloc.maxFreeBlock(),
    };
  }

  lookup(regionId: number, offset: number) {
    const alloc = this.loadAllocator(regionId);
    return alloc.lookup(offset);
  }

  verify(regionId: number) {
    const region = this.getRegion(regionId);
    const snap = this.snapshot(regionId);
    return verifyState(
      region.size,
      region.minOrder,
      snap.free,
      snap.allocations.map((a) => ({ offset: a.offset, size: a.size })),
    );
  }

  events(regionId: number): EventRow[] {
    this.getRegion(regionId);
    const rows = this.db
      .prepare(
        'SELECT seq, type, request_id AS requestId, steps, state_before AS stateBefore, state_after AS stateAfter, created_at AS createdAt FROM events WHERE region_id = ? ORDER BY seq',
      )
      .all(regionId) as unknown as Array<{
      seq: number;
      type: EventRow['type'];
      requestId: string | null;
      steps: string;
      stateBefore: string;
      stateAfter: string;
      createdAt: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      requestId: r.requestId,
      steps: JSON.parse(r.steps),
      stateBefore: JSON.parse(r.stateBefore),
      stateAfter: JSON.parse(r.stateAfter),
      createdAt: r.createdAt,
    }));
  }

  // 逐步回放：返回前 toSeq 个事件之后的状态（事件快照不可变，直接读取）
  replay(regionId: number, toSeq?: number): { seq: number; state: Snapshot }[] {
    const evs = this.events(regionId);
    const picked = toSeq === undefined ? evs : evs.filter((e) => e.seq <= toSeq);
    return picked.map((e) => ({ seq: e.seq, state: e.stateAfter }));
  }

  exportJson(regionId: number) {
    return {
      region: this.getRegion(regionId),
      state: this.state(regionId),
      verify: this.verify(regionId),
      events: this.events(regionId),
    };
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), 'data', 'buddy.sqlite');
}
