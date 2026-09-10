# Contract: the web surface

What `apps/core/web` guarantees, and what it deliberately does not.

## Route groups

```
src/app/(auth)/sign-in        signing in, including the second factor
src/app/(auth)/sign-up
src/app/(auth)/two-factor     reached only when a password alone is not enough
src/app/(app)/notes           the reference feature
src/app/(app)/settings/organizations
src/app/(app)/settings/devices
src/app/(app)/settings/security   turning the second factor on and off
```

The two groups differ in one thing: everything under `(app)` requires a
session, and its layout carries the header, the organization switcher and the
impersonation banner. Nothing under `(auth)` may require one, or signing in
would redirect to itself.

## What `proxy.ts` is and is not

`src/proxy.ts` is Next 16's rename of `middleware.ts`. It redirects a visitor
with no session cookie to `/sign-in`, carrying where they were going in a
`next` parameter.

**It is a redirect, not an authorisation check.** It reads only whether a
cookie is present; it does not validate it, because doing so would mean a
database round trip on every navigation. Everything that matters is decided by
the API, which verifies the session itself on every request. A forged cookie
gets somebody as far as an empty page and no further.

The `next` parameter is passed through `safeNext` before the browser is sent
anywhere. A value that is not a path on this site becomes `/notes`. Without
that test, `?next=https://example.com` would turn the sign-in page into a
redirector carrying this site's name to wherever an attacker chose.

It decides by **parsing**, not by inspecting the first characters, and that
difference is the whole point. The URL parser strips tab, newline and carriage
return from anywhere in a string *before* it parses, so `?next=/%0A/evil.com`
begins with exactly one slash, passes any prefix test, and still resolves to
another origin. The value is resolved against a sentinel origin and refused
unless it lands back on it.

## Language

The locale is a cookie, not a path segment. One set of routes, and no link has
to decide which language it belongs to. That suits an application behind a
sign-in; a public site being indexed would want the opposite.

The vocabulary — which languages exist, which is the default, what the cookie
is called — lives in `@workspace/shared-i18n`, so a second surface cannot
disagree with the first. The messages themselves stay in the application,
because they are its content.

An unknown cookie value is treated as absent and the default is used. A test
asserts the two catalogues carry exactly the same keys and that no value is
empty: a key present in one language only renders as its own dotted path in the
other, which reaches production looking like a layout bug rather than a missing
translation.

## Forms

Every form is `react-hook-form` with `useFormResolver`, and the schema comes
from `@workspace/shared-contracts` — the same object the API wraps in
`createZodDto`. A form that accepted what the service rejects would tell the
person filling it in only after they submitted.

`useFormResolver` rather than `zodResolver` directly, because the schemas carry
no messages and should not: they are shared with a service that answers
machines. Left to the library's defaults, the product's primary language would
show English next to fully translated labels. The resolver maps each issue to
the catalogue instead.

Controls come from `@workspace/shared-ui`, never from a repeated class string.
`Field` and `FieldError` place the label, the control and the message in the
shape a screen reader expects, and `aria-invalid` is what the design system's
controls colour themselves from — so every form reports an error the same way
without anyone deciding what red looks like.

That library is published as **source**, not as a build. A bundled barrel
merges every component into one file, and a per-file `"use client"` directive
does not survive that: the framework then sees one module calling
`createContext` with no directive and refuses to build.

Fields are **uncontrolled** (`register`), never `value`/`onChange`. A page is
interactive before it is hydrated, and a controlled input keeps its state in
React: anything typed before hydration sets the DOM value and is then thrown
away when React attaches, leaving a field that looks filled and submits empty.
Uncontrolled fields read the DOM at submit, so they cannot lose the keystroke.

## Sessions and the tenant

The active organization is held on the session, server-side. A value kept in
the browser would be a claim the caller makes about itself; every API request
derives its tenant from the session instead.

Changing it goes through `useSwitchOrganization` and nowhere else. That hook
sets the active organization *and* empties the query cache, because the two
belong together: the tenant appears in no request the cache can see, so two
organizations would otherwise share one entry and the second would be shown the
first's rows. Emptying is more honest than marking stale — stale data is still
displayed while it refetches, and here that would be another tenant's records
on screen.

Nothing re-reads the session by hand after a call that changes it. The auth
client already refreshes on those paths, and a second read racing the first can
land last and put the previous answer back on screen.

## Where a failure appears

A form's own errors sit beside the field they belong to, because that is where
the reader is looking. A failure that arrives after the reader has moved on —
an organization that would not switch, a session that would not revoke — goes
to a toast instead: the control that started it may be in the header, or gone.

## Impersonation

While an administrator is acting as somebody else, every page carries a banner
naming who, and leaving is one click. Impersonation without a visible marker is
indistinguishable from a hijacked session, both to the person watching a screen
share and to whoever reads the audit log afterwards.

## Enrolling a second factor

Two steps, never one. `enable` returns the secret and the backup codes but
switches nothing on; a code from the new device has to come back and match
first. One step would be a trap: a secret mis-scanned, or scanned into an
application the person then deletes, locks them out of their own account at the
next sign-in.

Both enabling and disabling ask for the password again. A session left open on
an unattended machine must not be enough to remove the control protecting the
account, nor to enrol a device its owner never sees.

## Where the API is, from the browser

`NEXT_PUBLIC_API_ORIGIN` names the origin the browser addresses API calls to.
In production that is the edge, which serves the application and the API under
one name. The API container's own address must never appear there.

**It has to be the same site as the application.** A session cookie set for one
origin is not sent to another, and `proxy.ts` reads that cookie to decide
whether somebody is signed in. Put the API on a different site and every
signed-in person is redirected back to sign in, signs in successfully, and is
redirected again — a loop with no error anywhere to explain it. Locally the two
differ only by port, which cookies ignore, so this is a mistake that appears
for the first time in a real deployment.

Next inlines a `NEXT_PUBLIC_*` variable **at build time**, so the value has to
be present when the image is built, not when the container starts. A production
image built without it ships a bundle pointing at `http://localhost:3000` and
fails in a way that looks like a network problem.

## What the browser is allowed to do

The API names the methods a browser may use, the headers it may read, and how
long it may cache the answer. Every one of those is invisible to a
command-line client, so the tests assert them explicitly:

- **Methods.** The plugin's default is `GET, HEAD, POST`. Under it every update
  and delete fails from a page while continuing to work from a tool.
- **Exposed headers.** Without them a page may read only the six safelisted
  response headers — so `x-request-id`, the id a caller is asked to quote when
  reporting a problem, is invisible to the only caller who would report it.
  `retry-after` and `location` are the same story.
- **The origin itself.** The plugin emits the method list and the credentials
  flag whether or not the origin matched, so a test that checks only those
  passes against a service configured for the wrong site. Every case in
  `apps/core/api-e2e/src/cors.e2e-spec.ts` also asserts the origin came back.
