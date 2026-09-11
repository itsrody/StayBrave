import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function resolveFromRoot(p) {
  return resolve(ROOT, p);
}

export function defaults() {
  return {
    fetch: {
      concurrency: 16,
      timeout_secs: 30,
      retries: 2,
      retry_delay_ms: 500,
      max_redirects: 5,
      expand_includes: true,
      max_include_depth: 4,
      cache_dir: '.cache',
      user_agent:
        'StayBrave-Classic/0.2 (filter-list optimizer for Firefox uBlock Origin; https://github.com/itsrody/StayBrave)',
    },
    output: {
      file: 'output/StayBrave-Classic.txt',
      title: 'StayBrave Classic',
      description:
        'StayBrave Classic is a merged, de-duplicated, sorted filter list for Firefox uBlock Origin 1.74+.',
      expires: '3 days',
      homepage: 'https://github.com/itsrody/StayBrave',
    },
    filter: {
      scriptlets: true,
      keep_trusted_only: false,
      network_optimize: true,
      rewrite_canonical_options: true,
      network_superset_subsumption: true,
      network_dead_by_exception: true,
      network_dead_exception: true,
      cosmetic_engine_filter: true,
      cosmetic_dead_hide_by_exception: true,
      cosmetic_dead_exception: true,
      cosmetic_cost: {
        split_comma_lists: false,
        subsume_selectors: true,
        subsume_procedural: true,
        merge_same_scope_selectors: true,
      },
    },
    // External lists already enabled in uBO (uBlocks' built-ins, EasyList in
    // the browser, …). Rules StayBrave-Classic ships that these lists already
    // provide are dropped, so no rule is duplicated/flagged "unused". Off by
    // default: a user who does not enable these lists keeps full coverage.
    provided_lists: [],
    lists: [],
  };
}

function mergeWithDefaults(cfg) {
  const d = defaults();
  const out = {
    fetch: { ...d.fetch, ...(cfg.fetch ?? {}) },
    output: { ...d.output, ...(cfg.output ?? {}) },
    filter: {
      ...d.filter,
      ...(cfg.filter ?? {}),
      cosmetic_cost: {
        ...d.filter.cosmetic_cost,
        ...(cfg.filter?.cosmetic_cost ?? {}),
      },
    },
    lists: [],
  };
  if (!Array.isArray(cfg.lists)) {
    throw new Error('lists.json: "lists" must be an array of list sources');
  }
  out.lists = cfg.lists.map((l, i) => {
    if (typeof l !== 'object' || l === null || !l.name || !l.url) {
      throw new Error(
        `lists.json: lists[${i}] must have a "name" and a "url"`
      );
    }
    return {
      name: String(l.name),
      url: String(l.url),
      enabled: l.enabled ?? true,
      hosts: l.hosts ?? false,
    };
  });
  // provided_lists are additional lists the user has enabled in uBO; each is
  // a { name, url } source fetched like a normal list but treated as
  // already-present coverage rather than merged output. `enabled:false` skips
  // a provided list (¬(subtract its rules)).
  if (cfg.provided_lists !== undefined) {
    if (!Array.isArray(cfg.provided_lists)) {
      throw new Error('lists.json: "provided_lists" must be an array');
    }
    out.provided_lists = cfg.provided_lists
      .filter((l) => l?.enabled ?? true)
      .map((l, i) => {
        if (!l || !l.name || !l.url) {
          throw new Error(
            `lists.json: provided_lists[${i}] must have a "name" and a "url"`
          );
        }
        return { name: String(l.name), url: String(l.url) };
      });
  } else {
    out.provided_lists = [];
  }
  return out;
}

export function loadConfig(path = 'lists.json') {
  const absolute = resolve(path);
  let raw;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (err) {
    throw new Error(`config ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config ${path}: invalid JSON: ${err.message}`);
  }
  return mergeWithDefaults(parsed);
}

export default function configFromCli(cli) {
  const cfg = loadConfig(cli.config);
  if (cli.output) cfg.output.file = cli.output;
  if (cli.resolve) {
    for (const key of Object.keys(cfg.fetch)) {
      const v = cfg.fetch[key];
      if (typeof v === 'string' && key.includes('path')) {
        cfg.fetch[key] = resolveFromRoot(v);
      }
    }
    cfg.fetch.cache_dir = resolveFromRoot(cfg.fetch.cache_dir);
    cfg.output.file = resolveFromRoot(cfg.output.file);
  }
  return cfg;
}