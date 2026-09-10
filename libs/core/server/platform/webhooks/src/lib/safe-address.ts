import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';

/** A destination that has been resolved and checked, and where to reach it. */
export interface PinnedDestination {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Why a destination was refused.
 *
 * A distinct type because the caller treats it differently from a delivery
 * that failed: a refused address is a configuration mistake the tenant has to
 * fix, and retrying it eight times is eight identical failures.
 */
export class UnsafeDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDestinationError';
  }
}

/**
 * Everything a webhook must never reach.
 *
 * The list is long because the interesting entries are the ones people forget.
 * `169.254.169.254` is the cloud metadata endpoint every write-up names, and
 * `fd00::/8` is the IPv6 equivalent of the private ranges, left out of most
 * hand-written blocklists.
 *
 * The v4-mapped v6 form — `::ffff:169.254.169.254` — is handled by
 * `unwrapMappedIPv4` below rather than by a subnet here, for a reason that had
 * to be measured.
 */
function blockedRanges(): BlockList {
  const blocked = new BlockList();

  // IPv4.
  blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
  blocked.addSubnet('10.0.0.0', 8, 'ipv4'); // private
  blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
  blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
  blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, and metadata
  blocked.addSubnet('172.16.0.0', 12, 'ipv4'); // private
  blocked.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
  blocked.addSubnet('192.168.0.0', 16, 'ipv4'); // private
  blocked.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
  blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
  blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, includes broadcast

  // IPv6.
  blocked.addAddress('::', 'ipv6'); // unspecified
  blocked.addAddress('::1', 'ipv6'); // loopback
  blocked.addSubnet('fc00::', 7, 'ipv6'); // unique local — fc00 and fd00
  blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
  blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast

  return blocked;
}

const BLOCKED = blockedRanges();

/**
 * An IPv4 address wearing a v6 hat, unwrapped.
 *
 * `::ffff:169.254.169.254` is the metadata address arriving on a v6 socket,
 * and a check that only knew the v4 ranges would let it straight through.
 *
 * The obvious fix — adding `::ffff:0:0/96` to the blocklist — is wrong, and
 * measured to be wrong: Node's `BlockList` treats that subnet as covering the
 * **entire** IPv4 space, so `check('8.8.8.8', 'ipv4')` answers `true` and
 * every webhook in the system is refused with a message claiming a public
 * address is private. Unwrapping first is what actually works: the address is
 * then checked against the v4 ranges it really belongs to.
 */
function unwrapMappedIPv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);

  if (mapped?.[1] !== undefined) {
    return mapped[1];
  }

  // The other spelling: `::ffff:a9fe:a9fe` is the same address in hex.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);

  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }

  return address;
}

/**
 * Resolves a webhook URL and refuses it unless the address it resolved to is
 * one this service may talk to.
 *
 * **The address is returned so the caller can connect to exactly it.** That is
 * the half most implementations miss: validating a hostname and then handing
 * the hostname to an HTTP client leaves a window in which DNS can answer
 * differently, and the second answer is the one the socket uses. Resolving
 * once and pinning closes it.
 *
 * `family: 0` asks for whatever the name has, rather than preferring v4 — a
 * name with only a AAAA record is a name this would otherwise fail to resolve
 * and report as broken.
 */
export async function pinDestination(
  raw: string,
  options: { readonly requireHttps: boolean },
): Promise<PinnedDestination> {
  const url = parse(raw, options.requireHttps);

  let resolved: { address: string; family: number };

  try {
    resolved = await lookup(url.hostname, { family: 0 });
  } catch {
    // Deliberately not the underlying message: a DNS error can carry the
    // resolver's own address, and this string reaches a tenant.
    throw new UnsafeDestinationError(
      `The host in ${url.origin} does not resolve.`,
    );
  }

  if (isBlockedAddress(resolved.address)) {
    // The address, not only the host: "webhook.acme.test is not allowed" tells
    // a tenant nothing, and the reason they need is that their name points at
    // an address inside our network.
    throw new UnsafeDestinationError(
      `${url.hostname} resolves to ${resolved.address}, which is a private, ` +
        'loopback, link-local or otherwise reserved address.',
    );
  }

  return {
    url,
    address: resolved.address,
    family: resolved.family === 4 ? 4 : 6,
  };
}

function parse(raw: string, requireHttps: boolean): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeDestinationError(`${raw} is not a URL.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeDestinationError(
      `${url.protocol} is not a scheme a webhook can use; expected https.`,
    );
  }

  if (requireHttps && url.protocol !== 'https:') {
    // Plain HTTP is allowed outside production so a developer can point an
    // endpoint at their own machine. In production the signature is the only
    // thing standing between the payload and anyone on the path, and a
    // signature does not encrypt.
    throw new UnsafeDestinationError(
      'A webhook endpoint must use https in production.',
    );
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in a URL are a way to smuggle a different host past a
    // careless parser, and they end up in logs.
    throw new UnsafeDestinationError(
      'A webhook URL must not carry credentials.',
    );
  }

  return url;
}

/**
 * The `lookup` a pinned request installs.
 *
 * Node calls it with `{ all: true }` and expects an **array** in that case;
 * returning a bare string then produces `ERR_INVALID_IP_ADDRESS` from inside
 * `net.connect`, which names nothing that would lead anyone here. Measured.
 */
export function pinnedLookup(destination: PinnedDestination) {
  return (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      error: null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    if (options?.all === true) {
      callback(null, [
        { address: destination.address, family: destination.family },
      ]);
      return;
    }

    callback(null, destination.address, destination.family);
  };
}

/** Whether an address is one this service may talk to. Exported for tests. */
export function isBlockedAddress(address: string): boolean {
  const unwrapped = unwrapMappedIPv4(address);

  return BLOCKED.check(unwrapped, isIPv4(unwrapped) ? 'ipv4' : 'ipv6');
}
