import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer } from '../src/server';

test('HTTP API 端到端', async () => {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-api-')), 'api.sqlite');
  const { server, port } = await startServer(0, db);
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${base}/regions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 16 }),
    }).then((r) => r.json());
    assert.equal(created.size, 16);

    const alloc = await fetch(`${base}/regions/${created.id}/alloc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'api1', bytes: 3 }),
    }).then((r) => r.json());
    assert.equal(alloc.size, 4);
    assert.equal(alloc.internalFrag, 1);

    const lookup = await fetch(`${base}/regions/${created.id}/lookup?offset=1`).then((r) => r.json());
    assert.equal(lookup.kind, 'allocated');

    const verify = await fetch(`${base}/regions/${created.id}/verify`).then((r) => r.json());
    assert.ok(verify.ok);

    const dup = await fetch(`${base}/regions/${created.id}/alloc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'api1', bytes: 3 }),
    });
    assert.equal(dup.status, 409);
    const dupBody = await dup.json();
    assert.equal(dupBody.error.code, 'DUPLICATE_REQUEST');

    const badFree = await fetch(`${base}/regions/${created.id}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'ghost' }),
    });
    assert.equal(badFree.status, 404);

    const free = await fetch(`${base}/regions/${created.id}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'api1' }),
    }).then((r) => r.json());
    assert.equal(free.size, 16);

    const events = await fetch(`${base}/regions/${created.id}/events`).then((r) => r.json());
    assert.equal(events.length, 3);

    const replay = await fetch(`${base}/regions/${created.id}/replay?to=2`).then((r) => r.json());
    assert.equal(replay.length, 2);

    const invalid = await fetch(`${base}/regions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 100 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    server.close();
  }
});
