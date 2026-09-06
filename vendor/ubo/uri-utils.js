// Node shim for uBO's src/js/uri-utils.js — exports only entityFromHostname,
// which cosmetic-filtering.js imports.  Mirrors master's exact logic; falls
// back to the npm-pinned domainFromHostname when no domain is supplied (our
// callers always pass request.domain).
import { domainFromHostname } from '@gorhill/ubo-core/js/uri-utils.js';

export function entityFromDomain(domain) {
  const pos = domain.indexOf('.');
  return pos !== -1 ? domain.slice(0, pos) + '.*' : '';
}

export function entityFromHostname(hostname, domain) {
  if (domain === undefined) {
    domain = domainFromHostname(hostname);
  }
  const entity = entityFromDomain(domain);
  if (entity === '') return '';
  return `${hostname.slice(0, -domain.length)}${entity}`;
}