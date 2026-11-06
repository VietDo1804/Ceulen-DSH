import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * Public-URL guard for the local fetch leg (plan 2.1).
 *
 * `new URL()` already normalises decimal and hex IPv4 literals (`2130706433`,
 * `0x7f000001`), so the literal checks below see `127.0.0.1`. The subnets are
 * taken from the IANA special-purpose registries: the private, reserved and
 * IPv4-embedding ranges listed here, not the whole registry. `node:net` applies the IPv4 rules to IPv4-mapped
 * IPv6 addresses (`::ffff:7f00:1`), so those need no special case.
 */
const blocked = new BlockList()
const IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]
const IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback and IPv4-compatible (`::127.0.0.1`)
  ['64:ff9b::', 96], // NAT64: can reach a private IPv4 behind the prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2001::', 32], // Teredo embeds an IPv4 address
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 embeds an IPv4 address
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8],
]
for (const [network, prefix] of IPV4_SUBNETS) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of IPV6_SUBNETS) blocked.addSubnet(network, prefix, 'ipv6')

export interface ResolvedAddress {
  readonly address: string
  readonly family: number
}

/** Injected in tests so DNS behaviour is hermetic. */
export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>

const resolveAll: Resolver = async host => await lookup(host, { all: true, verbatim: true })

function bareHost(hostname: string): string {
  const stripped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return stripped.endsWith('.') ? stripped.slice(0, -1) : stripped
}

/** True when this string is an IP literal inside a blocked range. */
export function isBlockedAddress(host: string): boolean {
  const bare = bareHost(host)
  const family = isIP(bare)
  if (family === 0) return false
  return family === 4 ? blocked.check(bare, 'ipv4') : blocked.check(bare, 'ipv6')
}

/** Lexical check: http(s) scheme, no localhost name, no blocked IP literal. */
export function isPublicUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = bareHost(url.hostname.toLowerCase())
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  return !isBlockedAddress(host)
}

/**
 * {@link isPublicUrl} plus DNS: a public hostname that resolves to a private
 * address is refused on every redirect hop.
 *
 * ponytail: the check and the connect are separate lookups, so a rebinding host
 * can win the race between them. Connecting to the resolved address would close
 * that window; this is the fallback leg, and the native `http` provider pins
 * connections for the primary path.
 */
export async function assertPublicUrl(value: string, resolve: Resolver = resolveAll): Promise<string> {
  if (!isPublicUrl(value)) throw new Error('refusing a non-public or malformed URL')
  const url = new URL(value)
  const host = bareHost(url.hostname.toLowerCase())
  if (isIP(host) !== 0) return url.href
  let addresses: readonly ResolvedAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new Error(`refusing an unresolvable host: ${host}`)
  }
  if (addresses.length === 0) throw new Error(`refusing an unresolvable host: ${host}`)
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw new Error(`refusing ${host}: it resolves to the non-public address ${entry.address}`)
    }
  }
  return url.href
}

/**
 * Ranges that are never a legitimate page to capture: link-local (cloud
 * metadata lives at 169.254.169.254), multicast, reserved, unspecified and
 * NAT64.
 */
const NEVER_CAPTURE = new BlockList()
const NEVER_CAPTURE_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
const NEVER_CAPTURE_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  // AWS's IPv6 metadata endpoint; ordinary link-local/ULA LAN hosts stay allowed
  // so an IPv6 dev server can still be audited.
  ['fd00:ec2::254', 128],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16], // 6to4: `2002:a9fe:a9fe::` embeds 169.254.169.254
]
for (const [network, prefix] of NEVER_CAPTURE_IPV4) NEVER_CAPTURE.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of NEVER_CAPTURE_IPV6) NEVER_CAPTURE.addSubnet(network, prefix, 'ipv6')

/**
 * Capture guard for the headless-Chrome tools. A capture can read a page's text
 * through `web_interact`, so the cloud metadata addresses get the same treatment
 * as the fetch guard: IPv4 link-local (169.254.169.254), AWS's IPv6 metadata,
 * multicast, reserved and NAT64 are refused, while loopback and LAN dev servers
 * (including IPv6 link-local) keep working — they are the documented UX-audit
 * flow, and bash can reach them anyway.
 *
 * This checks the first URL only. Redirects, scripts and subresources are held
 * by the Chrome resolver rule in `vendor/ceulen/web/chrome.ts`; keep its list in
 * step with `NEVER_CAPTURE`.
 *
 * ponytail: lexical only, no DNS. A public hostname that resolves to a private
 * address still passes here; closing that needs the async resolver and an async
 * capture guard.
 */
export function captureUrlProblem(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined // assertCaptureUrl already rejected a malformed URL
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = bareHost(url.hostname.toLowerCase())
  const family = isIP(host)
  if (family === 0) return undefined
  const never = family === 4 ? NEVER_CAPTURE.check(host, 'ipv4') : NEVER_CAPTURE.check(host, 'ipv6')
  return never ? `refusing a link-local, multicast or reserved capture URL (${host})` : undefined
}
