// Fetching, caching and include-expansion of raw list sources.
//
// Caching is ETag-based: the body and its validators are stored under
// `.cache/<sha256(url)>.json`, and every refresh sends an If-None-Match /
// If-Modified-Since conditional request. A 304 rebuilds the list from cache
// (cheap, correct while validators are synchronous), so scheduled rebuilds
// touch the network only when a source actually changed. `--offline` skips
// the network entirely and fails if anything is not cached.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIncludeDirective } from './preprocess.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveFromRoot(p) {
  return resolve(ROOT, p);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export class Fetcher {
  constructor(cfg) {
    this.cfg = cfg;
    this.cacheDir = resolveFromRoot(cfg.cache_dir);
    mkdirSync(this.cacheDir, { recursive: true });
    this.bytesTransferred = 0;
    this.fetchedFromCache = 0;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < Math.max(1, this.cfg.concurrency)) {
      this.active += 1;
      return () => {
        this.active -= 1;
        const next = this.waiters.shift();
        if (next !== undefined) next();
      };
    }
    return new Promise((resolvePromise) => {
      this.waiters.push(() => {
        this.active += 1;
        resolvePromise(() => {
          this.active -= 1;
          const next = this.waiters.shift();
          if (next !== undefined) next();
        });
      });
    });
  }

  cachePath(url) {
    return resolve(this.cacheDir, `${sha256(url)}.json`);
  }

  readCache(url) {
    try {
      const raw = readFileSync(this.cachePath(url), 'utf8');
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  writeCache(url, entry) {
    const path = this.cachePath(url);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, path);
  }

  // Fetch text for a URL with retries and ETag-based caching. Returns
  // `{ text, fromCache }`.
  async fetchWithRetry(url) {
    const cached = this.readCache(url);
    if (this.cfg.offline) {
      if (cached !== undefined) {
        this.fetchedFromCache += 1;
        return { text: cached.body, fromCache: true };
      }
      throw new Error(`offline mode: ${url} is not cached`);
    }

    const headers = {
      'User-Agent': this.cfg.user_agent,
      Accept: 'text/plain,text/raw,*/*;q=0.8',
    };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      (this.cfg.timeout_secs ?? 30) * 1000
    );
    try {
      for (let attempt = 0; attempt <= this.cfg.retries; attempt += 1) {
        const release = await this.acquire();
        let resp;
        try {
          resp = await fetch(url, {
            headers,
            redirect: 'follow',
            signal: controller.signal,
          });
        } catch (err) {
          release();
          if (attempt < this.cfg.retries) {
            await sleep(backoff(this.cfg.retry_delay_ms, attempt));
            continue;
          }
          throw new Error(`network error for ${url}: ${err.message}`);
        }
        let status;
        try {
          status = resp.status;
          if (resp.ok) {
            const body = await resp.text();
            status = 200;
            this.bytesTransferred += body.length;
            this.writeCache(url, {
              url,
              etag: resp.headers.get('etag') ?? null,
              lastModified: resp.headers.get('last-modified') ?? null,
              fetchedAt: new Date().toISOString(),
              body,
            });
            return { text: body, fromCache: false };
          }
        } finally {
          release();
        }
        if (status === 304 && cached !== undefined) {
          this.fetchedFromCache += 1;
          return { text: cached.body, fromCache: true };
        }
        if (status >= 500 && attempt < this.cfg.retries) {
          await sleep(backoff(this.cfg.retry_delay_ms, attempt));
          continue;
        }
        if (attempt < this.cfg.retries) {
          delete headers['If-None-Match'];
          delete headers['If-Modified-Since'];
          await sleep(backoff(this.cfg.retry_delay_ms, attempt));
          continue;
        }
        throw new Error(`HTTP ${status} for ${url}`);
      }
      throw new Error(`request failed after ${this.cfg.retries} retries: ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async expandIncludes(text, sourceUrl, depth = 0, visited = new Set()) {
    const out = [];
    for (const line of text.split('\n')) {
      const rawUrl = parseIncludeDirective(line);
      if (rawUrl === undefined) {
        out.push(line);
        continue;
      }
      const includeUrl = resolveIncludeUrl(sourceUrl, rawUrl);
      if (includeUrl === undefined) {
        out.push(`! StayBrave: could not resolve include ${rawUrl}`);
        continue;
      }
      if (depth >= this.cfg.max_include_depth) {
        out.push(`! StayBrave: include depth exceeded for ${includeUrl}`);
        continue;
      }
      if (visited.has(includeUrl)) {
        out.push(`! StayBrave: include cycle detected for ${includeUrl}`);
        continue;
      }
      visited.add(includeUrl);
      try {
        const { text: included } = await this.fetchWithRetry(includeUrl);
        const sub = await this.expandIncludes(
          included,
          includeUrl,
          depth + 1,
          visited
        );
        out.push(sub);
      } catch (err) {
        out.push(`! StayBrave: failed to expand include ${includeUrl}: ${err.message}`);
      }
    }
    return out.join('\n');
  }

  async fetchList(list) {
    const visited = new Set([list.url]);
    let includedFiles = 0;
    const root = await this.fetchWithRetry(list.url);
    let text = root.text;
    let bytes = text.length;
    if (this.cfg.expand_includes) {
      const expanded = await this.expandIncludes(
        text,
        list.url,
        0,
        visited
      );
      includedFiles = visited.size - 1;
      bytes = expanded.length;
      text = expanded;
    }
    return { text, bytes, includedFiles, rootFromCache: root.fromCache };
  }

  async fetchAll(lists) {
    const results = [];
    for (const source of lists.filter((l) => l.enabled)) {
      try {
        const fetched = await this.fetchList(source);
        results.push({ source, result: { ok: true, ...fetched } });
      } catch (err) {
        results.push({ source, result: { ok: false, error: err.message } });
      }
    }
    return results;
  }
}

export function resolveIncludeUrl(sourceUrl, raw) {
  try {
    const resolved = new URL(raw, sourceUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function backoff(baseMs, attempt) {
  return Math.min(baseMs * 2 ** attempt, 30_000);
}