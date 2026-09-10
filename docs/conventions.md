# Code conventions

The rules a reader of this repository needs that the code itself cannot state.
Everything here is enforced by a tool or provable with a command; nothing is a
matter of taste.

## Where a new capability goes

```
libs/core/server/platform/<name>    infrastructure any feature may depend on
libs/core/server/feature/<name>     business capability; features never import each other
libs/shared/<name>                  used by both the browser and the server
apps/core/<name>                    a deployable process
```

The two server layers make the dependency rule visible; ESLint is what
enforces it, through tags (`type:util`, `type:data-access`, `type:feature`) —
no rule reads a directory. A library in the wrong folder with the right tags
lints clean, so the folder is a convention held by review and the tag is the
one held by the tool. A feature that several other features need is not a
feature: it moves to `platform/`, and its tag moves with it.

Create every library with the generator, never by copying a folder:

```bash
pnpm nx g @workspace/workspace-plugin:feature-lib <name> --scope=core --platform=node
pnpm nx g @nx/js:library libs/core/server/platform/<name> \
  --name=core-server-<name> --tags=scope:core,platform:node,type:util \
  --unitTestRunner=vitest --linter=eslint --useProjectJson=true
```

Not only libraries. **Anything a generator makes, a generator makes** — pages
with `@nx/next:page`, components with `@nx/next:component`, a Nest module or
guard with `@nx/nest:module` / `@nx/nest:guard`. The generator puts the file
where the plugin expects it, names it the way the plugin's own tooling looks
for it, and hands you a spec file. Writing the file by hand skips all three,
and the spec is the one people notice missing last.

The defaults in `nx.json` make the generators produce what this workspace
actually uses — `style: none`, because styling is Tailwind and the shared
design system, not a CSS module beside every component. A generator whose
output has to be edited every time is a generator people stop running.

Move one with `nx g @nx/workspace:move`. It updates `project.json`, the
tsconfig references and the project graph together; `git mv` updates none of
them. Project names do not follow the folder, so a move changes no imports.

## Configuration a process reads

Every value a process reads from its environment goes through a Zod schema, and
the process refuses to start if one is missing or malformed. Nothing reads
`process.env` except the two places that build a connection before the
configuration module exists — the database client and the queue's connection —
and both fail loudly, naming the variable.

There are three schemas: a base every backend process shares, and one each for
the API and the worker. They are three **classes** — `BaseConfig`, `AppConfig`,
`WorkerConfig` — rather than one generic class, because the class is the
injection token and a type parameter would be erased: both processes would
share one token whose default type promised keys only one of them validates. A
module used by both injects `BaseConfig` and can only see what both processes
have.

A value belongs in the environment when it differs between deployments — a
port, an origin, a rate limit, a sweep interval. It does not when it is part of
the published API contract: a page-size ceiling is documented, generated into
the client, and cannot be changed per deployment without the client being
wrong.

Two processes never share a variable name for something that differs between
them. Both read the same shell in development, so one name means both connect
as whichever role it held, and the one that is wrong is the one with more
rights than it needs. Hence `DATABASE_URL` and `WORKER_DATABASE_URL`, with the
module naming which it uses: `DatabaseModule.forRoot('WORKER_DATABASE_URL')`.

`pnpm dev` tops up an existing `.env` from `.env.example` rather than only
creating a missing one. A variable added to the template after somebody's file
was written would otherwise reach them as a boot failure on a machine that
worked yesterday.

## Why library imports end in `.js`

**Inside a library, every relative import carries `.js`. Inside an application,
none of them do.** One rule each way — with one library that is the exception,
for a reason worth knowing.

`libs/shared/ui` is published as *source*: its `exports` point at `.tsx`, not at
a build. It has to be, because a bundled barrel merges every component into one
file and a per-file `"use client"` directive does not survive that — the
framework then sees one module calling `createContext` with no directive on it
and refuses to build. Since the bundler reads those files directly and resolves
specifiers literally, its imports are extensionless: there is no `.js` on disk
for `./components/ui/alert.js` to name.

Libraries are ESM (`"type": "module"`), and a Node ESM resolver requires an
explicit extension. The extension is `.js` even though the file is `.ts`,
because it names the *emitted* file. TypeScript refuses the alternative:

```
error TS2835: Relative import paths need explicit file extensions in ECMAScript
imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean
'./lib/serialisation/canonical-json.js'?
```

Applications are bundled — webpack for the API, Turbopack for the web — and a
bundler neither needs the extension nor benefits from it, so `apps/` imports
have none. The difference is a property of the two module systems, not a lapse.

Imports **between** projects never use a path: they use the package name
(`@workspace/core-server-core`), resolved by pnpm through the workspace.

## Which resolver a library uses

| Consumed by | `module` / `moduleResolution` | Libraries |
|---|---|---|
| Node only | `nodenext` (inherited from the base config) | everything under `libs/core/server/` |
| The browser as well | `esnext` / `bundler` | `shared-ui`, `shared-contracts`, `shared-i18n`, `shared-api-client-core` |

Of those, only `shared-ui` is published as source; the rest export a build, so
the framework reads their compiled `.js` and their `.js` specifiers resolve.

A library the web application imports must resolve the way the web application
does. Next.js is configured for `bundler`, and TypeScript builds one program
across a project reference: a library left on `nodenext` inside that program
reads the `require` half of a dual-published dependency while the application
reads the `import` half. Both halves declare the same types, so the compiler
sees two unrelated copies and rejects perfectly correct code:

```
Argument of type '{ ... }' is not assignable to parameter of type
'UseMutationOptions<...>'. Two different types with this name exist, but they
are unrelated.
```

Nothing about the source changes — only the two lines in `tsconfig.lib.json`.
The `.js` extensions stay, because `bundler` accepts them and one convention
beats two.

## Comments

Say why, not what. The reason belongs in the code; the pointer to a document
does not — a reader should not need another file open, and a reference rots the
moment documents move. Anything worth citing is worth restating in a sentence.

## Tests

| Kind | Where | What it may use |
|---|---|---|
| Unit | beside the code | nothing external; pure logic only |
| Integration | beside the code | `startPostgres()` from the testing library |
| API end-to-end | `apps/core/api-e2e` | the built artifact over HTTP |
| Browser end-to-end | `apps/core/web-e2e` | Playwright against a running stack |

Integration tests connect as `app_user`, a role row-level security can bind.
Never as the database owner: `FORCE ROW LEVEL SECURITY` does not apply to
superusers, and a suite that runs as one proves isolation it does not have.

The browser suite starts the built API itself, alongside the web server, so it
exercises the artifact rather than a stub. Both end-to-end suites therefore
want port 3000 and the same Redis, and both clear the rate-limit counters when
they start; they are marked `parallelism: false` so one never pulls the ground
out from under the other.

A page is interactive before it is hydrated. Anything typed in between can be
discarded when the framework attaches, so browser tests fill a field and then
assert it kept the value rather than trusting the keystroke.

## Verification

`pnpm verify` runs lint, typecheck, unit tests, build and end-to-end tests for
every project. `pnpm knip` finds unused files, exports and dependencies. Both
must be green before a commit.

A claim about how a tool behaves is worth what its evidence is worth. Run the
command, read the output, and if the two disagree, the output wins.
