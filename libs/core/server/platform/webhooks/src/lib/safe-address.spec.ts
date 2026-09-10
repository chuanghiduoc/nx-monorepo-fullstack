import { describe, expect, it } from 'vitest';

import {
  isBlockedAddress,
  pinDestination,
  pinnedLookup,
  UnsafeDestinationError,
} from './safe-address.js';

/**
 * Where a webhook is allowed to go.
 *
 * This is the file where being wrong is worst: a webhook is an outbound
 * request whose destination a tenant chooses, which is server-side request
 * forgery with the door held open. Every case below is one somebody has used.
 */
describe('deciding whether an address may be reached', () => {
  describe('the ranges', () => {
    it('refuses the cloud metadata address', () => {
      // The one every write-up names, and the one that hands over credentials.
      expect(isBlockedAddress('169.254.169.254')).toBe(true);
    });

    it('refuses it wearing an IPv6 hat', () => {
      // `::ffff:169.254.169.254` is the same address arriving on a v6 socket.
      // A blocklist that stopped at the v4 ranges would let this through, and
      // a hostname with only a AAAA record of this form is trivial to publish.
      expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    });

    it('refuses loopback in both families', () => {
      expect(isBlockedAddress('127.0.0.1')).toBe(true);
      expect(isBlockedAddress('127.1.2.3')).toBe(true);
      expect(isBlockedAddress('::1')).toBe(true);
    });

    it('refuses every private range', () => {
      expect(isBlockedAddress('10.1.2.3')).toBe(true);
      expect(isBlockedAddress('172.16.0.1')).toBe(true);
      expect(isBlockedAddress('172.31.255.255')).toBe(true);
      expect(isBlockedAddress('192.168.1.1')).toBe(true);
    });

    it('refuses the IPv6 ranges people leave out', () => {
      // `fd00::/8` is the v6 private range and is missing from most
      // hand-written blocklists; `fe80::` is link-local.
      expect(isBlockedAddress('fd00::1')).toBe(true);
      expect(isBlockedAddress('fc00::1')).toBe(true);
      expect(isBlockedAddress('fe80::1')).toBe(true);
    });

    it('refuses carrier-grade NAT and the reserved blocks', () => {
      expect(isBlockedAddress('100.64.0.1')).toBe(true);
      expect(isBlockedAddress('0.0.0.0')).toBe(true);
      expect(isBlockedAddress('255.255.255.255')).toBe(true);
    });

    it('allows an ordinary public address', () => {
      // The negative half: a blocklist that blocked everything would pass
      // every test above and deliver nothing.
      expect(isBlockedAddress('8.8.8.8')).toBe(false);
      expect(isBlockedAddress('93.184.216.34')).toBe(false);
      expect(isBlockedAddress('2606:4700::1')).toBe(false);
    });

    it('does not block 172.32, which is outside the private range', () => {
      // `172.16.0.0/12` ends at 172.31. Writing it as `172.0.0.0/8` is the
      // common mistake and blocks a great deal of the public internet.
      expect(isBlockedAddress('172.32.0.1')).toBe(false);
      expect(isBlockedAddress('172.15.0.1')).toBe(false);
    });
  });

  describe('the URL itself', () => {
    const anywhere = { requireHttps: false };

    it('refuses something that is not a URL', async () => {
      await expect(pinDestination('not a url', anywhere)).rejects.toThrow(
        UnsafeDestinationError,
      );
    });

    it('refuses a scheme that is not http or https', async () => {
      // `file:///etc/passwd` and `gopher://` are the classics.
      await expect(
        pinDestination('file:///etc/passwd', anywhere),
      ).rejects.toThrow(/scheme/i);
    });

    it('refuses credentials in the URL', async () => {
      // They are a way to smuggle a different host past a careless parser, and
      // they end up in every log the URL touches.
      await expect(
        pinDestination('https://user:pass@example.com/hook', anywhere),
      ).rejects.toThrow(/credentials/i);
    });

    it('refuses plain http when production is required', async () => {
      await expect(
        pinDestination('http://example.com/hook', { requireHttps: true }),
      ).rejects.toThrow(/https/i);
    });

    it('allows plain http when it is not', async () => {
      // A developer pointing an endpoint at their own machine. Refusing this
      // everywhere would mean the feature can only be tried in production.
      const pinned = await pinDestination('http://example.com/hook', anywhere);

      expect(pinned.url.protocol).toBe('http:');
    });
  });

  describe('resolving', () => {
    it('refuses a name that resolves into the private ranges', async () => {
      // `localhost` is the shortest way to say it, and the message has to name
      // the address rather than the host: "webhook.acme.test is not allowed"
      // tells a tenant nothing they can act on.
      await expect(
        pinDestination('http://localhost:9999/hook', { requireHttps: false }),
      ).rejects.toThrow(/resolves to (127\.0\.0\.1|::1)/);
    });

    it('returns the address it validated, not just an approval', async () => {
      // The whole point. A function that answered yes or no would leave the
      // caller to resolve the name again, and the second answer is the one the
      // socket would use.
      const pinned = await pinDestination('https://example.com/hook', {
        requireHttps: true,
      });

      expect(pinned.address).toMatch(/[.:]/);
      expect(isBlockedAddress(pinned.address)).toBe(false);
      expect(pinned.url.hostname).toBe('example.com');
    });

    it('says so when a name does not resolve at all', async () => {
      await expect(
        pinDestination('https://nx-test-no-such-host.invalid/hook', {
          requireHttps: true,
        }),
      ).rejects.toThrow(/does not resolve/);
    });
  });

  describe('the lookup that pins it', () => {
    const destination = {
      url: new URL('https://example.com/hook'),
      address: '93.184.216.34',
      family: 4 as const,
    };

    it('answers with an array when Node asks for all of them', () => {
      // Getting this wrong produces `ERR_INVALID_IP_ADDRESS` from deep inside
      // `net.connect`, which names nothing that would lead anybody here.
      // Measured against a real request before this was written.
      const lookup = pinnedLookup(destination);
      let answer: unknown;

      lookup('example.com', { all: true }, (_error, address) => {
        answer = address;
      });

      expect(answer).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });

    it('answers with the address when it does not', () => {
      const lookup = pinnedLookup(destination);
      let answer: unknown;
      let family: unknown;

      lookup('example.com', undefined, (_error, address, resolvedFamily) => {
        answer = address;
        family = resolvedFamily;
      });

      expect(answer).toBe('93.184.216.34');
      expect(family).toBe(4);
    });

    it('ignores the hostname it is handed', () => {
      // The pin is the point: whatever the name resolves to a millisecond
      // later, the socket goes to the address that was validated.
      const lookup = pinnedLookup(destination);
      let answer: unknown;

      lookup('something-else.example', { all: true }, (_error, address) => {
        answer = address;
      });

      expect(answer).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
  });
});
