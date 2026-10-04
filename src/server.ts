// HTTP API：仅使用 node:http，无外部依赖。默认端口 0（自动选择空闲端口）。
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { BuddyError } from './buddy';
import { defaultDbPath, Store } from './store';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof BuddyError) {
    const status =
      err.code === 'INVALID_PARAM'
        ? 400
        : err.code === 'ALLOC_NOT_FOUND'
          ? 404
          : err.code === 'DUPLICATE_REQUEST'
            ? 409
            : err.code === 'OUT_OF_MEMORY'
              ? 409
              : 400;
    send(res, status, { error: { code: err.code, message: err.message, detail: err.detail ?? null } });
  } else {
    send(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BuddyError('INVALID_PARAM', '请求体必须是合法 JSON');
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/') {
        return send(res, 200, {
          name: 'buddy-sim',
          endpoints: [
            'POST /regions {size, minOrder?}',
            'GET /regions',
            'GET /regions/:id/state',
            'POST /regions/:id/alloc {requestId, bytes}',
            'POST /regions/:id/free {requestId}',
            'GET /regions/:id/lookup?offset=N',
            'GET /regions/:id/verify',
            'GET /regions/:id/events',
            'GET /regions/:id/replay?to=SEQ',
            'GET /regions/:id/export',
          ],
        });
      }

      if (method === 'POST' && url.pathname === '/regions') {
        const body = await readBody(req);
        const region = store.createRegion(Number(body.size), body.minOrder === undefined ? 0 : Number(body.minOrder));
        return send(res, 201, region);
      }
      if (method === 'GET' && url.pathname === '/regions') {
        return send(res, 200, store.listRegions());
      }

      if (parts[0] === 'regions' && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new BuddyError('INVALID_PARAM', '区域 id 必须为整数');
        const sub = parts[2];
        if (method === 'GET' && sub === 'state') return send(res, 200, store.state(id));
        if (method === 'GET' && sub === 'verify') return send(res, 200, store.verify(id));
        if (method === 'GET' && sub === 'events') return send(res, 200, store.events(id));
        if (method === 'GET' && sub === 'export') return send(res, 200, store.exportJson(id));
        if (method === 'GET' && sub === 'lookup') {
          return send(res, 200, store.lookup(id, Number(url.searchParams.get('offset'))));
        }
        if (method === 'GET' && sub === 'replay') {
          const to = url.searchParams.get('to');
          return send(res, 200, store.replay(id, to === null ? undefined : Number(to)));
        }
        if (method === 'POST' && sub === 'alloc') {
          const body = await readBody(req);
          return send(res, 201, store.allocate(id, String(body.requestId ?? ''), Number(body.bytes)));
        }
        if (method === 'POST' && sub === 'free') {
          const body = await readBody(req);
          return send(res, 200, store.free(id, String(body.requestId ?? '')));
        }
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `未知路由: ${method} ${url.pathname}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(port = 0, dbPath = defaultDbPath()): Promise<{ server: http.Server; port: number }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const dbArg = process.argv.find((a) => a.startsWith('--db='));
  const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT ?? 0);
  startServer(Number.isInteger(port) ? port : 0, dbArg ? dbArg.split('=')[1] : defaultDbPath()).then(
    ({ port: p }) => {
      console.log(`buddy-sim API 已启动: http://127.0.0.1:${p} (数据目录: ./data)`);
    },
  );
}
