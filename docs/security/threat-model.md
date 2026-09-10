# Threat model

What this platform defends against, what it does not, and the test or database
constraint behind each claim. Every "prevented by" line names something you can
run; a row with no such line is a statement of intent and is marked as one.

This describes what exists today. It is revised when a boundary moves, not on a
schedule.

## Trust boundaries

```
  browser                edge                 API                database
     │  public origin      │  loopback          │  app_user         │
     ├────────────────────►├───────────────────►├──────────────────►│
     │  session cookie     │  X-Forwarded-*     │  transaction-local│
     │  or nothing         │  from a named hop  │  tenant setting   │
```

Four boundaries, each with a different assumption:

1. **Browser → edge.** Everything from here is hostile until proved otherwise.
   The browser is not trusted to say who it is, which organization it is acting
   in, or where it came from.
2. **Edge → API.** The edge is trusted to report the client's address and
   protocol, and only the hops named in `TRUSTED_PROXIES` are. Anything else
   claiming to be a proxy is ignored.
3. **API → database.** The API connects as `app_user`, a role with no DDL, no
   `BYPASSRLS` and no superuser bit. The database, not the service, decides
   which rows exist.
4. **Inside the API.** A request's tenant is resolved once, at the edge of the
   process, and carried in transaction-local settings. No query names an
   organization.

## What an attacker can reach, and what stops them

### Another organization's data

**The attack.** A signed-in member of organization A reads, edits or deletes
rows belonging to organization B — by guessing an identifier, by replaying a
cursor, or by finding a route whose author forgot a `where` clause.

**Prevented by** row-level security, not by application code. Every
`TENANT_OWNED` table carries a policy with both `USING` and `WITH CHECK`
clauses reading a transaction-local setting. A query that names no organization
returns only the current one's rows, and an insert that names another
organization is refused by the database.

The application role is bound by those policies because it is not the table
owner: `FORCE ROW LEVEL SECURITY` binds owners and has never bound superusers.
`rls-harness.spec.ts` asserts, before any isolation test runs, that
`current_user` is neither `rolsuper` nor `rolbypassrls` and that `SET ROLE
postgres` fails — so a green isolation suite cannot be green for the wrong
reason. `isolation.spec.ts` then proves an organization sees only its own rows,
and `notes.e2e-spec.ts` proves the same thing over HTTP: another organization's
note answers 404, which is also the answer for one that does not exist.

**Residual risk.** Raw SQL is the author's responsibility. Policies still
apply, but a query that joins across a `SYSTEM` table can read rows no policy
covers. `$queryRaw` is deliberately outside the tenant guard, and that is
recorded where the guard is defined.

### Data with no tenant at all

**The attack.** A code path opens a system transaction — one with no
organization set — and reads a tenant-scoped table, which under the policy
returns nothing, or worse, is written to with no organization.

**Prevented by** an accessor that refuses. `db.system()` returns a proxy that
throws on any tenant-scoped model rather than returning an empty list. The list
of scoped models is generated at build time from the schema's own class
comments, so a new table is covered by adding a comment, and an unclassified
model is a hard error rather than a default. `tenant-guard.spec.ts` covers both
directions.

### Somebody else's session

**The attack.** Stealing a session cookie, or making a signed-in browser act on
an attacker's behalf.

**Prevented by** three things at once:

- The cookie is `HttpOnly`, so script cannot read it. Asserted in
  `api.e2e-spec.ts`.
- It is `SameSite`, so it is not attached to a cross-site request.
- A state-changing request must carry an allowed `Origin` or authenticate with
  an API key — something a browser cannot attach on a signed-in user's behalf.
  `OriginCheckGuard` enforces it, and the check is against an exact list, never
  a prefix.

**Residual risk.** The application and the API must be the same site. If they
are not, the browser will not send the cookie and the application appears
broken rather than insecure — but the deployment is wrong either way.

### The sign-in page as a redirector

**The attack.** `?next=https://attacker.example` on the sign-in page, so
somebody who has just typed their password lands on a site that looks like this
one.

**Prevented by** `safeNext`, which resolves the value against a sentinel origin
and refuses anything that does not land back on it. A prefix test is not
enough: the URL parser strips tab, newline and carriage return from anywhere in
a string before parsing, so `/%0A/attacker.example` begins with one slash and
still leaves the origin. `safe-next.spec.ts` covers the control characters, the
protocol-relative form, and a property that every accepted value stays on this
origin.

### An API key used beyond its scope

**The attack.** A key issued for one integration reads what its issuer could
read, or acts in an organization it was not issued for.

**Prevented by** resolving an api-key principal to the key's own permissions,
never the issuing user's, and by `enableSessionForAPIKeys: false` so a key
never becomes a session. The tenant hook's api-key branch never consults
cookies, which is asserted directly rather than assumed.

### Rows edited by two people at once

**The attack.** Not malicious, but the same shape: one person's change silently
replaces another's.

**Prevented by** a version on every mutable row and an update whose `WHERE`
clause names it. A mismatch answers 409 and changes nothing. The contract
refuses an update that names no field to change, because such an update still
raises the version and makes every other open editor stale.

### A request replayed

**The attack.** A retry after a timeout charges twice, or a webhook is
delivered three times.

**Prevented by** a durable idempotency record with a lease and a fence token,
keyed by a caller-supplied header. `idempotency.store.spec.ts` covers the
concurrent case: of many simultaneous claims, exactly one wins.

### Requests in volume

**The attack.** Credential stuffing, or simply enough traffic to exhaust the
service.

**Reduced by** a rate limit keyed on the client's address, held in the Redis
instance that never evicts. The address comes from `request.ip`, which is
derived from `X-Forwarded-*` only for the hops named in `TRUSTED_PROXIES` —
reading the header directly would let any caller name its own address and
make the limit meaningless. Both directions are asserted: a forged header from
an untrusted hop does not change `request.ip`, and the same header from the
configured edge does.

**Residual risk.** This is a single-instance limit on one dimension. It is not
a defence against a distributed attack, and it is not a substitute for
something in front of the edge.

### An administrator acting as somebody else

**The attack.** Impersonation used without the person's knowledge, or an
administrator who forgets they are in it.

**Reduced by** making it visible rather than by preventing it: while
`impersonatedBy` is set, every page carries a banner naming who is acting as
whom, and leaving is one click. Impersonation without a marker is
indistinguishable from a hijacked session to anyone reading a screen share or
an audit log afterwards.

**Residual risk.** The banner is in the browser. It tells the operator what is
happening; the record that survives is the audit event, and the audit trail
itself is Phase 4 work.

### A second factor that locks out its owner

**The attack.** Not an attacker at all — a secret scanned into an application
the person then deletes, leaving them unable to sign in.

**Prevented by** enrolling in two steps. Turning it on returns the secret and
the backup codes but switches nothing on; a code from the new device has to
come back and match first. `two-factor.spec.ts` covers the case where enrolment
is abandoned: the account still signs in with a password alone.

Both enabling and disabling ask for the password again, so a session left open
on an unattended machine is not enough to remove the control protecting the
account.

## Tables with no tenant policy, and why

| Class | Policy | Why |
|---|---|---|
| `TENANT_OWNED` | `USING` + `WITH CHECK` on the organization | Every row belongs to exactly one |
| `TENANT_OPTIONAL` | Organization's row, or the person's own when no organization is active | The personal branch additionally requires no organization to be set, or a member would see colleagues' private rows |
| `GLOBAL` | None | Shared reference data with no owner |
| `SYSTEM` | None | Belongs to no tenant; reached through grants, not policies |
| `AUTH` | None | Isolation is the authentication library's own, and a policy here would fight it |

The `AUTH` row is the one worth stating plainly: sessions, accounts, members
and organizations are the library's tables, and it enforces who may read them
through its own endpoints. Putting a tenant policy on them would break the
sign-in path — a person has no organization until after they are
authenticated — so the boundary is the library's API, not the database.

## What a forged cursor gets

A pagination cursor is base64 of a small JSON object: a sort key, an
identifier, a hash of the query it was produced under, and a direction. It is
not signed.

Forging one lets a caller ask for a page starting at a position of their
choosing **within what they are already allowed to see**. It does not widen
that set: the query still runs inside the tenant transaction, and the policy
still applies. The length is capped so a hostile client cannot make the service
base64-decode and parse megabytes, and a malformed cursor is a 400.

## Not defended against

Stated so nobody assumes otherwise:

- **A compromised database owner or superuser.** `FORCE ROW LEVEL SECURITY`
  does not bind them, by design.
- **A compromised API process.** It holds the credentials for `app_user` and
  can do anything that role can.
- **Denial of service.** The rate limit reduces accidental and casual load. It
  is not a mitigation for a distributed attack.
- **Anything before the edge.** TLS termination, WAF rules and network access
  are the deployment's responsibility.
- **Malicious code in a dependency.** The lockfile is checked against
  supply-chain policy on install, and dependency updates are reviewed, but a
  package that ships a backdoor in a version that passes review is not caught
  here.

## Where the claims are checked

| Claim | Checked by |
|---|---|
| The application role cannot bypass a policy | `rls-harness.spec.ts` |
| An organization sees only its own rows | `isolation.spec.ts`, `notes.e2e-spec.ts` |
| A tenant-scoped read with no tenant throws | `tenant-guard.spec.ts` |
| Session cookies are `HttpOnly` | `api.e2e-spec.ts` |
| A browser may use the methods the application needs | `cors.e2e-spec.ts` |
| The sign-in page cannot be turned into a redirector | `safe-next.spec.ts`, `auth.spec.ts` |
| A second factor is required once enrolled | `two-factor.spec.ts` |
| A stale edit is refused | `notes.e2e-spec.ts` |
| One of many simultaneous claims wins | `idempotency.store.spec.ts` |
| Every migration applies to an empty database | `migrations.spec.ts` |
