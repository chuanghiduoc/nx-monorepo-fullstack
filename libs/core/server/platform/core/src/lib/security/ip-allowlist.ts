import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Whether an address is admitted by a list of addresses and CIDR ranges.
 *
 * `node:net`'s `BlockList` does the matching: it understands both families and
 * both notations, and it is the same code Node uses for its own address
 * checks. Comparing strings, or splitting on dots, is where allowlists grow
 * the bug that lets `10.0.0.10` through a rule written for `10.0.0.1`.
 *
 * An empty list admits everyone. That is the absence of a rule, not a rule
 * that admits nobody — an organization that has configured nothing has not
 * asked to be locked out.
 */
export function isAddressAllowed(
  address: string,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) {
    return true;
  }

  const candidate = normalise(address);
  if (!candidate) {
    // An address we cannot parse cannot be matched against a rule, and
    // guessing would guess towards letting it in.
    return false;
  }

  const list = new BlockList();
  let usable = 0;

  for (const entry of allowlist) {
    if (addRule(list, entry)) {
      usable += 1;
    }
  }

  if (usable === 0) {
    // Every rule was unusable. Admitting everyone here would turn a
    // misconfigured allowlist into no allowlist at all, silently.
    return false;
  }

  return list.check(candidate.address, candidate.family);
}

interface Candidate {
  address: string;
  family: 'ipv4' | 'ipv6';
}

/**
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what a dual-stack listener reports
 * for an IPv4 client. A rule written as `127.0.0.1` must still match it.
 */
function normalise(address: string): Candidate | undefined {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped ? mapped[1] : address;

  if (isIPv4(plain)) {
    return { address: plain, family: 'ipv4' };
  }
  if (isIPv6(address)) {
    return { address, family: 'ipv6' };
  }
  return undefined;
}

function addRule(list: BlockList, entry: string): boolean {
  const [address, prefix] = entry.split('/');
  const candidate = normalise(address);

  if (!candidate) {
    return false;
  }

  try {
    if (prefix === undefined) {
      list.addAddress(candidate.address, candidate.family);
    } else {
      list.addSubnet(candidate.address, Number(prefix), candidate.family);
    }
    return true;
  } catch {
    // A malformed rule is ignored rather than fatal: one bad entry must not
    // lock an organization out of its own data, and `usable` above makes sure
    // a list of nothing but bad entries does not admit everyone either.
    return false;
  }
}
