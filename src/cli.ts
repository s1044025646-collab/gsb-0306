// CLI：直接操作本地 SQLite 数据目录（默认 ./data/buddy.sqlite，可用 --db= 覆盖）。
import * as fs from 'node:fs';
import { BuddyError } from './buddy';
import { renderIntervalTable } from './render';
import { defaultDbPath, Store } from './store';

function argValue(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}

const USAGE = `buddy-sim CLI（阶约定: 块大小 = 2^order 字节, 偏移按块大小对齐, 伙伴 = offset XOR size）
用法: node dist/src/cli.js <命令> [参数] [--db=路径]
  create --size=1024 [--min-order=0]        创建区域（大小须为 2 的幂）
  regions                                   列出区域
  alloc --region=1 --id=req1 --bytes=100    申请
  free --region=1 --id=req1                 释放
  state --region=1                          区间表
  lookup --region=1 --offset=64             查询偏移归属
  verify --region=1                         不变量核验
  history --region=1                        事件历史（含不可变快照）
  replay --region=1 [--to=SEQ]              逐步回放
  export --region=1 [--out=file.json]       导出 JSON
  serve [--port=0]                          启动 HTTP API（默认选空闲端口）
`;

export function runCli(argv: string[], store: Store): number {
  const cmd = argv[0];
  try {
    switch (cmd) {
      case 'create': {
        const size = Number(argValue(argv, 'size'));
        const minOrder = argValue(argv, 'min-order');
        const region = store.createRegion(size, minOrder === undefined ? 0 : Number(minOrder));
        console.log(`已创建区域 #${region.id}: 大小 ${region.size} 字节, minOrder=${region.minOrder}`);
        return 0;
      }
      case 'regions':
        console.table(store.listRegions());
        return 0;
      case 'alloc': {
        const r = store.allocate(
          Number(argValue(argv, 'region')),
          String(argValue(argv, 'id') ?? ''),
          Number(argValue(argv, 'bytes')),
        );
        console.log(
          `分配成功: ${r.requestId} -> 偏移 ${r.offset}, 实际占用 ${r.size} 字节, 内部碎片 ${r.internalFrag} 字节 (事件 #${r.seq})`,
        );
        for (const s of r.steps)
          console.log(`  [${s.action}] order=${s.order} offset=${s.offset} size=${s.size} ${s.note ?? ''}`);
        return 0;
      }
      case 'free': {
        const r = store.free(Number(argValue(argv, 'region')), String(argValue(argv, 'id') ?? ''));
        console.log(`释放成功: ${r.requestId} -> 合并后空闲块 [${r.offset}, +${r.size}) (事件 #${r.seq})`);
        for (const s of r.steps)
          console.log(`  [${s.action}] order=${s.order} offset=${s.offset} size=${s.size} ${s.note ?? ''}`);
        return 0;
      }
      case 'state': {
        const s = store.state(Number(argValue(argv, 'region')));
        console.log(renderIntervalTable(s.region.size, s.free, s.allocations));
        console.log(`空闲总量 ${s.totalFree} 字节, 最大空闲块 ${s.maxFreeBlock} 字节`);
        return 0;
      }
      case 'lookup': {
        const r = store.lookup(Number(argValue(argv, 'region')), Number(argValue(argv, 'offset')));
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }
      case 'verify': {
        const r = store.verify(Number(argValue(argv, 'region')));
        if (r.ok) console.log('不变量核验通过：不重叠、完整覆盖、对齐、大小为 2 的幂、无可合并空闲伙伴');
        else {
          console.log('核验失败:');
          for (const i of r.issues) console.log(`  [${i.rule}] ${i.detail}`);
        }
        return r.ok ? 0 : 1;
      }
      case 'history': {
        for (const e of store.events(Number(argValue(argv, 'region')))) {
          console.log(`#${e.seq} ${e.type} ${e.requestId ?? ''} @ ${e.createdAt} 步骤=${e.steps.length}`);
        }
        return 0;
      }
      case 'replay': {
        const regionId = Number(argValue(argv, 'region'));
        const to = argValue(argv, 'to');
        const states = store.replay(regionId, to === undefined ? undefined : Number(to));
        const size = store.getRegion(regionId).size;
        for (const s of states) {
          console.log(`--- 回放至事件 #${s.seq} ---`);
          console.log(renderIntervalTable(size, s.state.free, s.state.allocations));
        }
        return 0;
      }
      case 'export': {
        const data = store.exportJson(Number(argValue(argv, 'region')));
        const out = argValue(argv, 'out');
        const json = JSON.stringify(data, null, 2);
        if (out) {
          fs.writeFileSync(out, json);
          console.log(`已导出到 ${out}`);
        } else {
          console.log(json);
        }
        return 0;
      }
      case 'serve': {
        const port = Number(argValue(argv, 'port') ?? process.env.PORT ?? 0);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createServer } = require('./server') as typeof import('./server');
        const server = createServer(store);
        server.listen(Number.isInteger(port) ? port : 0, '127.0.0.1', () => {
          const addr = server.address();
          console.log(`API 已启动: http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`);
        });
        return 0;
      }
      default:
        process.stderr.write(USAGE);
        return cmd ? 2 : 0;
    }
  } catch (err) {
    if (err instanceof BuddyError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      if (err.detail) console.error(`详情: ${JSON.stringify(err.detail)}`);
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dbArg = argv.find((a) => a.startsWith('--db='));
  const store = new Store(dbArg ? dbArg.split('=')[1] : defaultDbPath());
  const rest = argv.filter((a) => !a.startsWith('--db='));
  const code = runCli(rest, store);
  if (rest[0] !== 'serve') {
    store.close();
    process.exit(code);
  }
}
