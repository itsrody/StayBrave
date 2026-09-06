import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fetcher } from '../src/fetch.js';

const realFetch = globalThis.fetch;

function mockFetch(script) {
  // script: (url, headers) => [status, headersMap, body] | undefined
  globalThis.fetch = async (url, init) => {
    const hit = script(url, init?.headers);
    if (hit === undefined) throw new Error(`no script entry for ${url}`);
    const [status, headers, body] = hit;
    return {
      ok: status === 200,
      status,
      headers: { get: (name) => headers?.[name] ?? null },
      text: async () => body,
    };
  };
}

describe('fetch cache', () => {
  let dir;

  beforeEach(() => {
    dir = join(tmpdir(), `staybrave-cache-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = realFetch;
  });

  it('reuses a 304 via If-None-Match without transferring bytes', async () => {
    const fetcher = new Fetcher({
      concurrency: 1,
      retries: 0,
      cache_dir: dir,
    });
    mockFetch((url, headers) => {
      if (headers['If-None-Match'] === '"v1"') return [304, {}, null];
      return [200, { etag: '"v1"' }, 'line1\nline2\n'];
    });

    const first = await fetcher.fetchWithRetry('https://example.com/a.txt');
    assert.equal(first.fromCache, false);
    assert.equal(fetcher.bytesTransferred, 12);

    const second = await fetcher.fetchWithRetry('https://example.com/a.txt');
    assert.equal(second.fromCache, true);
    assert.equal(second.text, 'line1\nline2\n');
    assert.equal(fetcher.bytesTransferred, 12);
  });

  it('treats a 200 with byte-identical body as a cache hit and stores the new etag', async () => {
    const fetcher = new Fetcher({
      concurrency: 1,
      retries: 0,
      cache_dir: dir,
    });
    mockFetch((url, headers) => {
      if (headers['If-None-Match'] === '"v1"') {
        return [200, { etag: '"v2"' }, 'abc\n'];
      }
      return [200, { etag: '"v1"' }, 'abc\n'];
    });

    const first = await fetcher.fetchWithRetry('https://example.com/b.txt');
    assert.equal(first.fromCache, false);
    assert.equal(fetcher.bytesTransferred, 4);

    const second = await fetcher.fetchWithRetry('https://example.com/b.txt');
    assert.equal(second.fromCache, true);
    assert.equal(second.text, 'abc\n');
    assert.equal(fetcher.bytesTransferred, 4);

    const entry = JSON.parse(
      readFileSync(fetcher.cachePath('https://example.com/b.txt'), 'utf8')
    );
    assert.equal(entry.etag, '"v2"');
  });
});