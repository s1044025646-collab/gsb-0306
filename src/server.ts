// HTTP API 服务（仅后端，无前端）
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { Store } from './store';
import { BuddyError } from './buddy';

const DATA_DIR = process.env.BUDDY_DATA_DIR ?? path.join(process.cwd(), 'data');

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof BuddyError) {
    send(res, 400, { error: { code: err.code, message: err.message, detail: err.detail ?? null } });
  } else {
    send(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); } catch {
    throw new BuddyError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      // /regions
      if (parts[0] === 'regions' && parts.length === 1) {
        if (method === 'POST') {
          const body = await readBody(req);
          const region = store.createRegion(Number(body.sizeBytes), String(body.name ?? ''));
          return send(res, 201, { region });
        }
        if (method === 'GET') return send(res, 200, { regions: store.listRegions() });
      }
      const regionId = parts[0] === 'regions' ? Number(parts[1]) : NaN;
      if (parts[0] === 'regions' && Number.isInteger(regionId)) {
        const sub = parts[2];
        if (!sub && method === 'GET') {
          return send(res, 200, { region: store.getRegion(regionId), snapshot: store.loadSnapshot(regionId) });
        }
        if (sub === 'status' && method === 'GET') {
          const alloc = store.loadAllocator(regionId);
          return send(res, 200, {
            region: store.getRegion(regionId),
            snapshot: alloc.snapshot(),
            totalFree: alloc.totalFree(),
            maxFreeBlock: alloc.maxFreeBlockSize(),
            verify: store.verify(regionId),
          });
        }
        if (sub === 'allocations' && method === 'POST') {
          const body = await readBody(req);
          const requestId = String(body.requestId ?? '');
          const bytes = Number(body.bytes);
          const { event, result } = store.applyOperation(regionId, (a) => ({
            type: 'allocate', requestId, ...a.allocate(requestId, bytes),
          }));
          return send(res, 201, { allocation: result.alloc, steps: result.steps, eventSeq: event.seq });
        }
        if (sub === 'free' && method === 'POST') {
          const body = await readBody(req);
          const requestId = String(body.requestId ?? '');
          const { event, result } = store.applyOperation(regionId, (a) => ({
            type: 'free', requestId, ...a.release(requestId),
          }));
          return send(res, 200, { freed: result.alloc, steps: result.steps, eventSeq: event.seq });
        }
        if (sub === 'address' && method === 'GET') {
          const offset = Number(url.searchParams.get('offset'));
          const alloc = store.loadAllocator(regionId);
          return send(res, 200, alloc.queryAddress(offset));
        }
        if (sub === 'events' && method === 'GET') {
          if (parts[3]) return send(res, 200, { event: store.getEvent(regionId, Number(parts[3])) });
          return send(res, 200, { events: store.listEvents(regionId) });
        }
        if (sub === 'replay' && method === 'GET') {
          const to = url.searchParams.get('to');
          return send(res, 200, store.replay(regionId, to === null ? undefined : Number(to)));
        }
        if (sub === 'verify' && method === 'GET') {
          return send(res, 200, store.verify(regionId));
        }
        if (sub === 'export' && method === 'GET') {
          return send(res, 200, store.exportRegion(regionId));
        }
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `${method} ${url.pathname}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function main(): Promise<void> {
  const portArg = process.env.PORT ? Number(process.env.PORT) : undefined;
  const store = new Store(DATA_DIR);
  const server = createServer(store);
  const port = portArg ?? (await findFreePort());
  server.listen(port, '127.0.0.1', () => {
    console.log(`Buddy 模拟器 API 已启动: http://127.0.0.1:${port}  数据目录: ${DATA_DIR}`);
  });
}

if (require.main === module) {
  void main();
}
