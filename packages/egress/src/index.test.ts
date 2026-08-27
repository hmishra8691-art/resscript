/**
 * @resscript/egress — the shared SSRF predicate.
 *
 * These cases live with the function rather than only in its callers, because the function is the
 * thing being shared and a rule that is only exercised through apps/runtime would be one whose
 * behaviour apps/worker inherits untested.
 *
 * Every case is one a plausible implementation gets wrong:
 *
 *  * `169.254.169.254` blocked by ADDRESS, so an allowlisted hostname resolving there is refused;
 *  * the 172.16/12 boundary in both directions, because blocking all of 172/8 breaks real customer
 *    APIs and teaches an operator to distrust the check;
 *  * `::ffff:` IPv4-mapped IPv6, which none of the v6 prefix rules match;
 *  * unparseable input, which must block rather than allow.
 */

import { describe, expect, it } from 'vitest';

import { isBlockedAddress } from './index.js';

describe('isBlockedAddress — IPv4', () => {
  it('blocks every cloud metadata address by name', () => {
    // The target this module exists to stop. Named explicitly as well as caught by the link-local
    // rule, because a defence that depends on one rule is one refactor from gone.
    expect(isBlockedAddress('169.254.169.254', 4)).toBe(true);
    expect(isBlockedAddress('169.254.170.2', 4)).toBe(true);
    expect(isBlockedAddress('100.100.100.200', 4)).toBe(true);
  });

  it('blocks the RFC1918 ranges', () => {
    expect(isBlockedAddress('10.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('172.16.0.1', 4)).toBe(true);
    expect(isBlockedAddress('172.31.255.255', 4)).toBe(true);
    expect(isBlockedAddress('192.168.1.1', 4)).toBe(true);
  });

  it('does NOT block 172.15 or 172.32, which are outside RFC1918', () => {
    // The off-by-one that makes a blocklist wrong in the safe-looking direction. 172.16/12 is the
    // range; blocking all of 172/8 would break legitimate customer APIs and teach an operator to
    // stop trusting the allowlist.
    expect(isBlockedAddress('172.15.0.1', 4)).toBe(false);
    expect(isBlockedAddress('172.32.0.1', 4)).toBe(false);
  });

  it('blocks loopback, this-host, CGNAT and multicast', () => {
    expect(isBlockedAddress('127.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('127.1.2.3', 4)).toBe(true); // all of 127/8, not just .0.1
    expect(isBlockedAddress('0.0.0.0', 4)).toBe(true);
    expect(isBlockedAddress('100.64.0.1', 4)).toBe(true);
    expect(isBlockedAddress('224.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('255.255.255.255', 4)).toBe(true);
  });

  it('blocks anything it cannot parse, rather than allowing it', () => {
    // The direction of the default is the point. An address this function cannot reason about is
    // one it cannot vouch for, and "unparseable therefore fine" is how a blocklist is bypassed.
    expect(isBlockedAddress('not-an-address', 4)).toBe(true);
    expect(isBlockedAddress('10.0.0', 4)).toBe(true);
    expect(isBlockedAddress('999.1.1.1', 4)).toBe(true);
    expect(isBlockedAddress('', 4)).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('93.184.216.34', 4)).toBe(false);
    expect(isBlockedAddress('1.1.1.1', 4)).toBe(false);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('blocks loopback, unspecified, link-local, ULA and multicast', () => {
    expect(isBlockedAddress('::1', 6)).toBe(true);
    expect(isBlockedAddress('::', 6)).toBe(true);
    expect(isBlockedAddress('fe80::1', 6)).toBe(true);
    expect(isBlockedAddress('fd00::1', 6)).toBe(true);
    expect(isBlockedAddress('fc00::1', 6)).toBe(true);
    expect(isBlockedAddress('ff02::1', 6)).toBe(true);
  });

  it('blocks the AWS IMDSv6 address', () => {
    expect(isBlockedAddress('fd00:ec2::254', 6)).toBe(true);
  });

  it('blocks an IPv4-mapped address by its IPv4 rules', () => {
    // The bypass the v6 rules alone miss entirely: ::ffff:169.254.169.254 is the metadata endpoint
    // wearing a hat, and none of the v6 prefixes above match it.
    expect(isBlockedAddress('::ffff:169.254.169.254', 6)).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1', 6)).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1', 6)).toBe(true);
  });

  it('allows a mapped PUBLIC address, so the mapping rule is not a blanket ban', () => {
    expect(isBlockedAddress('::ffff:93.184.216.34', 6)).toBe(false);
  });

  it('is case-insensitive, because a resolver may return either', () => {
    expect(isBlockedAddress('FE80::1', 6)).toBe(true);
    expect(isBlockedAddress('FD00::1', 6)).toBe(true);
  });

  it('allows an ordinary public v6 address', () => {
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946', 6)).toBe(false);
  });
});
