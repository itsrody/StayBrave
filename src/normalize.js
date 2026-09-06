// Pre-parse normalization of filter syntax coming from other families into
// rules uBO's parser accepts. Every candidate produced here is still handed to
// the real parser (src/ubo.js), so a translation can never change semantics
// silently: if the rewritten text does not parse, it is dropped.

const localAliases = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'ip6-mcastprefix',
  'ip6-allnodes',
  'ip6-allrouters',
  'ip6-allhosts',
  'broadcasthost',
  'local',
]);

export const isIp = (() => {
  const v4Parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const v6 = /^[0-9A-Fa-f:]+(?::[0-9A-Fa-f]*)?$/;
  return (s) => {
    if (typeof s !== 'string') return false;
    const m = s.match(v4Parts);
    if (m !== null) {
      return m.slice(1).every((octet) => Number(octet) <= 255);
    }
    return /^[0-9A-Fa-f:]{2,}$/.test(s) && s.includes(':');
  };
})();

export function isHostname(s) {
  return (
    s !== '' &&
    s.length <= 253 &&
    /^[0-9A-Za-z.\-_]+$/.test(s)
  );
}

function hostsDomains(line) {
  const tokens = line.trim().split(/\s+/);
  const domains = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('#')) break;
    let host = token.replace(/\.$/, '');
    if (host.startsWith('*.')) host = host.slice(2);
    host = host.toLowerCase();
    if (isHostname(host) && !localAliases.has(host)) {
      domains.push(host);
    }
  }
  return domains;
}

// Normalize a single line from any supported list family. IP-led lines are
// hosts-style and are always expanded into `||domain^` (their raw text would
// be misread as a substring filter). uBO natively understands `$empty`/`$mp4`
// shorthands and the dotted redirect resource names, so option rewriting is
// limited to canonicalizing old redirect aliases.
export function normalizeLine(line) {
  const trimmed = line.trim();
  const first = trimmed.split(/\s+/)[0];
  if (isIp(first)) {
    const domains = hostsDomains(trimmed);
    return {
      lines: domains.map((d) => `||${d}^`),
      hostsConverted: domains.length > 0,
    };
  }
  const normalized = normalizeOptions(trimmed);
  return {
    lines: [normalized],
    hostsConverted: false,
  };
}

export function normalizeHostsLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
    return { lines: [], hostsConverted: false };
  }
  const first = trimmed.split(/\s+/)[0];
  if (isIp(first)) {
    const domains = hostsDomains(trimmed);
    return {
      lines: domains.map((d) => `||${d}^`),
      hostsConverted: domains.length > 0,
    };
  }
  if (isHostname(trimmed) && !trimmed.includes('$') && !trimmed.includes('#')) {
    return { lines: [`||${trimmed}^`], hostsConverted: true };
  }
  const normalized = normalizeOptions(trimmed);
  return { lines: [normalized], hostsConverted: false };
}

const canonicalResource = new Map([
  ['1x1-transparent.gif', '1x1.gif'],
  ['2x2-transparent.png', '2x2.png'],
  ['3x2-transparent.png', '3x2.png'],
  ['32x32-transparent.png', '32x32.png'],
  ['noopjs', 'noop.js'],
  ['nooptext', 'noop.txt'],
  ['noopframe', 'noop.html'],
  ['noopjson', 'noop.json'],
  ['noopmp4-1s', 'noop-1s.mp4'],
  ['noopmp4-2s', 'noop-2s.mp4'],
  ['noopmp4-3s', 'noop-3s.mp4'],
  ['noopmp3-0.1s', 'noop-0.1s.mp3'],
  ['noopmp3-0.5s', 'noop-0.5s.mp3'],
  ['noopvast-2.0', 'noop-vast2.xml'],
  ['noopvast-3.0', 'noop-vast3.xml'],
  ['noopvast-4.0', 'noop-vast4.xml'],
  ['noopvmap-1.0', 'noop-vmap1.xml'],
  ['noop-vmap1.0.xml', 'noop-vmap1.xml'],
  ['blank-js', 'noop.js'],
  ['blank-mp4', 'noop-1s.mp4'],
  ['blank-mp3', 'noop-0.1s.mp3'],
  ['amazon-adsystem.com/aax2/amzn_ads.js', 'amazon_ads.js'],
  ['ampproject.org/v0.js', 'ampproject_v0.js'],
  ['doubleclick.net/instream/ad_status.js', 'doubleclick_instream_ad_status.js'],
  ['google-analytics.com/cx/api.js', 'google-analytics_cx_api.js'],
  ['google-analytics.com/ga.js', 'google-analytics_ga.js'],
  ['google-analytics.com/inpage_linkid.js', 'google-analytics_inpage_linkid.js'],
  ['static.chartbeat.com/chartbeat.js', 'chartbeat.js'],
  ['google-ima3', 'google-ima.js'],
  ['widgets.outbrain.com/outbrain.js', 'outbrain-widget.js'],
  ['popads.net.js', 'popads.js'],
  ['prevent-popads-net.js', 'popads.js'],
  ['scorecardresearch.com/beacon.js', 'scorecardresearch_beacon.js'],
]);

function canonicalResourceValue(name) {
  const stripped = name.startsWith('abp-resource:') ? name.slice('abp-resource:'.length) : name;
  return canonicalResource.get(stripped) ?? name;
}

function normalizeOptions(raw) {
  const idx = raw.lastIndexOf('$');
  if (idx === -1) return raw;
  const pattern = raw.slice(0, idx);
  const options = raw.slice(idx + 1);
  let changed = false;
  const rebuilt = [];
  for (const opt of options.split(',')) {
    const translated = translateOption(opt);
    changed ||= translated !== opt;
    rebuilt.push(translated);
  }
  if (!changed) return raw;
  return `${pattern}$${rebuilt.join(',')}`;
}

function translateOption(opt) {
  const eq = opt.indexOf('=');
  if (eq === -1) return opt;
  const name = opt.slice(0, eq);
  const value = opt.slice(eq + 1);
  if (name === 'redirect' || name === 'redirect-rule' || name === 'rewrite') {
    const canonical = canonicalResourceValue(value);
    return canonical === value ? opt : `${name}=${canonical}`;
  }
  return opt;
}