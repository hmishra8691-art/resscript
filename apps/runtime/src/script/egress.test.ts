/**
 * The egress proxy — security §5.3, roadmap P2-11.
 *
 * Every test here is a refusal, because the value of this module is entirely in what it does not
 * do. A proxy that fetches allowlisted URLs is trivial; a proxy that cannot be talked into reading
 * the cloud instance's IAM credentials is the whole deliverable. The cases are chosen to be the
 * ones a plausible implementation gets wrong:
 *
 *  - `169.254.169.254` blocked *by address*, not by string match on the URL, so an allowlisted
 *    hostname that resolves there is still refused;
 *  - `::ffff:` IPv4-mapped IPv6, which the v6 rules alone let through;
 *  - a bare IP literal in the URL, including its octal and hex spellings — closed by the exact-match
 *    allowlist rather than by the address rules, which is worth pinning precisely BECAUSE the
 *    defence is not where you would look for it;
 *  - a hostname resolving to one public AND one private address, which "check the first result"
 *    turns into a coin flip.
 *
 * The DNS resolver is stubbed via a seam rather than hitting the network: a security test whose
 * outcome depends on what a public DNS server says today is a test that will one day pass for the
 * wrong reason.
 */

import { describe, expect, it } from 'vitest';

import { createEgressProxy, EgressDenied, isBlockedAddress } from './egress.js';

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


/* ---------------------------------------------------------------- *
 * check() — the allowlist, the scheme, and what survives DNS
 * ---------------------------------------------------------------- */

/** A stub resolver: host → addresses. An unlisted host fails to resolve, like a real one. */
function resolver(table: Record<string, { address: string; family: number }[]>) {
  return async (host: string) => {
    const hit = table[host];
    if (hit === undefined) throw new Error('ENOTFOUND');
    return hit;
  };
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function proxy(
  hosts: readonly string[],
  table: Record<string, { address: string; family: number }[]>,
) {
  return createEgressProxy({ hosts, resolve: resolver(table) });
}

async function denialOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof EgressDenied) return err.reason;
    return `unexpected: ${String(err)}`;
  }
  return 'no denial';
}

describe('check — scheme and port', () => {
  const p = proxy(['api.acme.example'], { 'api.acme.example': PUBLIC });

  it('permits an allowlisted https host that resolves public', async () => {
    const r = await p.check({ method: 'GET', url: 'https://api.acme.example/v1/x' });
    expect(r.address).toBe('93.184.216.34');
    expect(r.host).toBe('api.acme.example');
  });

  it('refuses http, even for an allowlisted host', async () => {
    // An org allowlist is not a reason to send a survey's data in clear text.
    expect(await denialOf(() => p.check({ method: 'GET', url: 'http://api.acme.example/x' }))).toBe(
      'scheme',
    );
  });

  it('refuses the classic SSRF schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://api.acme.example/', 'dict://x/']) {
      expect(await denialOf(() => p.check({ method: 'GET', url }))).toBe('scheme');
    }
  });

  it('refuses a non-standard port', async () => {
    // An allowlist entry names a host; a host that also opens 6379 is a Redis nobody meant to
    // expose.
    expect(
      await denialOf(() => p.check({ method: 'GET', url: 'https://api.acme.example:6379/' })),
    ).toBe('port');
    // ...but the explicit default port is the same request as the implicit one.
    await expect(p.check({ method: 'GET', url: 'https://api.acme.example:443/' })).resolves.toBeDefined();
  });
});

describe('check — the allowlist', () => {
  it('refuses a host the org did not allowlist', async () => {
    const p = proxy(['api.acme.example'], {
      'api.acme.example': PUBLIC,
      'evil.example': PUBLIC,
    });
    expect(await denialOf(() => p.check({ method: 'GET', url: 'https://evil.example/' }))).toBe(
      'host_not_allowlisted',
    );
  });

  it('matches the allowlist case-insensitively, since DNS is', async () => {
    const p = proxy(['api.acme.example'], { 'api.acme.example': PUBLIC });
    await expect(
      p.check({ method: 'GET', url: 'https://API.ACME.EXAMPLE/x' }),
    ).resolves.toBeDefined();
  });

  it('does NOT treat an allowlist entry as a suffix wildcard', async () => {
    // `*.acme.example` would admit `metadata.acme.example` pointed anywhere its owner likes. An
    // allowlist an attacker can extend is not one.
    const p = proxy(['acme.example'], { 'evil.acme.example': PUBLIC });
    expect(
      await denialOf(() => p.check({ method: 'GET', url: 'https://evil.acme.example/' })),
    ).toBe('host_not_allowlisted');
  });

  it('refuses a bare IP literal, in every spelling, because none is an allowlisted host', async () => {
    // The address rules never see these: an allowlist entry is a hostname, so a URL whose host is
    // a numeric literal fails the exact match first. Pinned because the octal and hex spellings are
    // the classic way past a *regex* on the URL, and it matters that the defence here does not
    // depend on parsing them at all.
    const p = proxy(['api.acme.example'], { 'api.acme.example': PUBLIC });
    for (const host of ['169.254.169.254', '127.0.0.1', '2130706433', '0x7f000001', '0177.0.0.1']) {
      expect(await denialOf(() => p.check({ method: 'GET', url: `https://${host}/` }))).toBe(
        'host_not_allowlisted',
      );
    }
  });

  it('refuses a host that does not resolve', async () => {
    const p = proxy(['api.acme.example'], {});
    expect(await denialOf(() => p.check({ method: 'GET', url: 'https://api.acme.example/' }))).toBe(
      'dns',
    );
  });
});

describe('check — what survives DNS', () => {
  it('refuses an ALLOWLISTED host that resolves to the metadata endpoint', async () => {
    // The headline. The host allowlist passes — the org really did allow this name — and the
    // address check is the only thing between a survey script and the instance's IAM credentials.
    const p = proxy(['api.acme.example'], {
      'api.acme.example': [{ address: '169.254.169.254', family: 4 }],
    });
    expect(await denialOf(() => p.check({ method: 'GET', url: 'https://api.acme.example/' }))).toBe(
      'blocked_address',
    );
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    // "Check result[0]" turns a host with one public and one private address into a coin flip, and
    // whoever controls the DNS record chooses the order.
    const p = proxy(['api.acme.example'], {
      'api.acme.example': [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect(await denialOf(() => p.check({ method: 'GET', url: 'https://api.acme.example/' }))).toBe(
      'blocked_address',
    );
  });

  it('refuses a mapped-IPv6 metadata address', async () => {
    const p = proxy(['api.acme.example'], {
      'api.acme.example': [{ address: '::ffff:169.254.169.254', family: 6 }],
    });
    expect(await denialOf(() => p.check({ method: 'GET', url: 'https://api.acme.example/' }))).toBe(
      'blocked_address',
    );
  });

  it('pins the checked address, so the connection cannot re-resolve', async () => {
    // The returned address is what `perform` connects to. Handing the hostname to the connection
    // instead would reopen the DNS-rebinding window the check just closed, so this asserts the
    // check hands back an ADDRESS rather than only a verdict.
    const p = proxy(['api.acme.example'], { 'api.acme.example': PUBLIC });
    const r = await p.check({ method: 'GET', url: 'https://api.acme.example/x' });
    expect(r.address).toBe('93.184.216.34');
    expect(isBlockedAddress(r.address, r.family)).toBe(false);
  });
});

describe('check — method and header restrictions', () => {
  const p = proxy(['api.acme.example'], { 'api.acme.example': PUBLIC });

  it('permits the ordinary verbs', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'get', 'post']) {
      await expect(
        p.check({ method, url: 'https://api.acme.example/' }),
      ).resolves.toBeDefined();
    }
  });

  it('refuses TRACE and CONNECT', async () => {
    for (const method of ['TRACE', 'CONNECT', 'OPTIONS']) {
      expect(
        await denialOf(() => p.check({ method, url: 'https://api.acme.example/' })),
      ).toBe('method');
    }
  });

  it('refuses a script-set Host header', async () => {
    // Host is what pins the request to the address that was checked; a script that could set it
    // could aim a checked connection at an unchecked vhost.
    expect(
      await denialOf(() =>
        p.check({
          method: 'GET',
          url: 'https://api.acme.example/',
          headers: { Host: 'metadata.google.internal' },
        }),
      ),
    ).toBe('header');
  });

  it('refuses the forwarding headers, case-insensitively', async () => {
    // A script that can set X-Forwarded-For can lie to whatever is behind the allowlisted host
    // about who called it.
    for (const name of ['X-Forwarded-For', 'x-real-ip', 'FORWARDED', 'x-forwarded-host']) {
      expect(
        await denialOf(() =>
          p.check({ method: 'GET', url: 'https://api.acme.example/', headers: { [name]: 'x' } }),
        ),
      ).toBe('header');
    }
  });

  it('refuses the hop-by-hop headers a script has no business setting', async () => {
    for (const name of ['Connection', 'Transfer-Encoding', 'Content-Length', 'Upgrade']) {
      expect(
        await denialOf(() =>
          p.check({ method: 'GET', url: 'https://api.acme.example/', headers: { [name]: 'x' } }),
        ),
      ).toBe('header');
    }
  });

  it('permits ordinary headers a script legitimately needs', async () => {
    await expect(
      p.check({
        method: 'POST',
        url: 'https://api.acme.example/',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      }),
    ).resolves.toBeDefined();
  });
});
