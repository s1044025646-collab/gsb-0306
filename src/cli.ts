// CLI：创建区域、申请、释放、状态、查询、回放、历史、导出、核验
import * as path from 'node:path';
import { Store } from './store';
import { Snapshot } from './buddy';

const DATA_DIR = process.env.BUDDY_DATA_DIR ?? path.join(process.cwd(), 'data');

function renderTable(totalSize: number, snap: Snapshot): string {
  interface Row { start: number; end: number; kind: string; order: number }
  const rows: Row[] = [];
  for (const b of snap.freeBlocks) {
    rows.push({ start: b.offset, end: b.offset + 2 ** b.order, kind: '空闲', order: b.order });
  }
  for (const a of snap.allocations) {
    rows.push({ start: a.offset, end: a.offset + a.size, kind: `占用(${a.requestId}, 请求${a.requested}B)`, order: a.order });
  }
  rows.sort((x, y) => x.start - y.start);
  const lines = rows.map((r) =>
    `  [${String(r.start).padStart(6)}, ${String(r.end).padStart(6)})  大小 ${String(r.end - r.start).padStart(6)}B  阶 ${String(r.order).padStart(2)}  ${r.kind}`);
  return `区域 [0, ${totalSize}) 共 ${totalSize}B\n${lines.join('\n')}`;
}

function fail(err: unknown): never {
  if (err && typeof err === 'object' && 'code' in err) {
    const e = err as { code: string; message: string; detail?: unknown };
    console.error(`错误 [${e.code}] ${e.message}`);
    if (e.detail) console.error(`详情: ${JSON.stringify(e.detail)}`);
  } else {
    console.error(String(err));
  }
  process.exit(1);
}

const USAGE = `用法: node dist/src/cli.js <命令> [参数]
  create <sizeBytes> [name]     创建区域（大小须为 2 的幂）
  list                          列出区域
  alloc <region> <reqId> <bytes>  申请内存
  free <region> <reqId>         释放内存
  status <region>               区间表展示占用/空闲
  query <region> <offset>       查询偏移归属
  events <region>               操作历史
  replay <region> [toSeq]       逐步回放
  verify <region>               不变量核验
  export <region>               导出 JSON
环境变量: BUDDY_DATA_DIR 指定数据目录（默认 ./data）
约定: 阶 order 表示块大小 2^order 字节；同阶多候选取偏移最小者；
      拆分时低地址半块优先用于本次申请；伙伴偏移 = offset XOR 块大小。`;

export function run(argv: string[]): void {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help') { console.log(USAGE); return; }
  const store = new Store(DATA_DIR);
  try {
    switch (cmd) {
      case 'create': {
        const region = store.createRegion(Number(args[0]), args[1] ?? '');
        console.log(`已创建区域 #${region.id}，大小 ${region.total_size}B，最大阶 ${region.max_order}`);
        break;
      }
      case 'list': {
        for (const r of store.listRegions()) {
          console.log(`#${r.id}  ${r.total_size}B  最大阶 ${r.max_order}  ${r.name}  (${r.created_at})`);
        }
        break;
      }
      case 'alloc': {
        const [region, reqId, bytes] = [Number(args[0]), args[1], Number(args[2])];
        const { result, event } = store.applyOperation(region, (a) => ({
          type: 'allocate', requestId: reqId, ...a.allocate(reqId, bytes),
        }));
        const al = result.alloc!;
        console.log(`申请成功 [事件#${event.seq}] ${reqId}: 偏移 ${al.offset}，实际 ${al.size}B，内部碎片 ${al.size - al.requested}B`);
        for (const s of result.steps) console.log(`  ${s.action} order=${s.order} offset=${s.offset} ${s.note ?? ''}`);
        break;
      }
      case 'free': {
        const [region, reqId] = [Number(args[0]), args[1]];
        const { result, event } = store.applyOperation(region, (a) => ({
          type: 'free', requestId: reqId, ...a.release(reqId),
        }));
        console.log(`释放成功 [事件#${event.seq}] ${reqId}`);
        for (const s of result.steps) console.log(`  ${s.action} order=${s.order} offset=${s.offset} ${s.note ?? ''}`);
        break;
      }
      case 'status': {
        const region = store.getRegion(Number(args[0]));
        console.log(renderTable(Number(region.total_size), store.loadSnapshot(region.id)));
        console.log(`不变量核验: ${JSON.stringify(store.verify(region.id))}`);
        break;
      }
      case 'query': {
        const alloc = store.loadAllocator(Number(args[0]));
        console.log(JSON.stringify(alloc.queryAddress(Number(args[1])), null, 2));
        break;
      }
      case 'events': {
        for (const e of store.listEvents(Number(args[0]))) {
          console.log(`#${e.seq} ${e.type} ${e.request_id} @${e.created_at}`);
          console.log(`  ${e.detail}`);
        }
        break;
      }
      case 'replay': {
        const region = store.getRegion(Number(args[0]));
        const { events, state } = store.replay(region.id, args[1] === undefined ? undefined : Number(args[1]));
        for (const e of events) console.log(`#${e.seq} ${e.type} ${e.request_id}`);
        console.log(renderTable(Number(region.total_size), state));
        break;
      }
      case 'verify': {
        console.log(JSON.stringify(store.verify(Number(args[0])), null, 2));
        break;
      }
      case 'export': {
        console.log(JSON.stringify(store.exportRegion(Number(args[0])), null, 2));
        break;
      }
      default:
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    fail(err);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2));
}
