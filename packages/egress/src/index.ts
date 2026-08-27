/**
 * @resscript/egress — the one definition of "an address our servers must never connect to".
 *
 * ## Why this is a package and not a function in two places
 *
 * There are two SSRF sinks in this system and they are the same problem: `survey.http` inside the
 * QuickJS sandbox (apps/runtime's egress proxy, ADR-005/P2-11) and outbound webhook delivery
 * (apps/worker, P2-10). Both fetch a URL a customer supplied, from inside our network, with our
 * network position.
 *
 * I first wrote this as a copied file in each app with a comment explaining that the copies were
 * byte-identical. That justification did not survive being written down. Two subtly different
 * address blocklists is strictly worse than one: the second is the one nobody remembers when a new
 * cloud metadata address appears, and an attacker only needs the weaker of the two. A comment
 * asking future maintainers to keep two files in sync is a comment, not a mechanism.
 *
 * The cost of a package here is a workspace entry and a build reference. The cost of a copy is a
 * security rule that can drift silently. That is not a close call.
 *
 * ## Zero dependencies, deliberately
 *
 * Same rule ADR-010 sets for `packages/logic`: this must be importable from anywhere, including
 * contexts with no Node built-ins available. It takes an already-resolved address and answers a
 * question about it — it does no DNS, opens no socket, and reads no configuration. The callers own
 * the resolving and the connecting, because those differ (one pins and connects over https with a
 * budget, the other posts a signed body), and only the verdict is shared.
 */

/** The metadata addresses, by name, because they are the target this whole module exists to stop. */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS / Azure / GCP / DigitalOcean / Oracle
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv6
]);

/**
 * Is this a resolved address our servers must never connect to?
 *
 * Exported because it is the security-critical predicate and deserves to be tested directly rather
 * than only through a live request. Written against the parsed octets, not against a regex on the
 * string: `010.0.0.1` and `0x0a000001` are both `10.0.0.1` to a resolver, and a string check would
 * pass them.
 */
export function isBlockedAddress(address: string, family: number): boolean {
  if (METADATA_ADDRESSES.has(address.toLowerCase())) return true;

  if (family === 4) {
    const octets = address.split('.').map(part => Number(part));
    if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
      // Unparseable is blocked, not allowed: an address this function cannot reason about is one
      // it cannot vouch for.
      return true;
    }
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8 — "this host"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. every metadata endpoint
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true; // multicast
  // An IPv4-mapped IPv6 address is an IPv4 address wearing a hat, and checking only the v6 rules
  // would let ::ffff:169.254.169.254 straight through.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedAddress(mapped[1], 4);
  return false;
}
