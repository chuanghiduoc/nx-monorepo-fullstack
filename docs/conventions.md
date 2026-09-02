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

Move one with `nx g @nx/workspace:move`. It updates `project.json`, the
tsconfig references and the project graph together; `git mv` updates none of
them. Project names do not follow the folder, so a move changes no imports.

## Why library imports end in `.js`

Libraries are ESM (`"type": "module"`) under `moduleResolution: nodenext`, and
that resolver requires an explicit extension on a relative import. The
extension is `.js` even though the file is `.ts`, because it names the *emitted*
file. TypeScript refuses the alternative:

```
error TS2835: Relative import paths need explicit file extensions in ECMAScript
imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean
'./lib/serialisation/canonical-json.js'?
```

Applications are bundled to CommonJS by webpack, where the extension is neither
required nor useful, so `apps/` imports have none. The inconsistency is real
and is a property of the two module systems, not a lapse.

Imports **between** projects never use a path: they use the package name
(`@workspace/core-server-core`), resolved by pnpm through the workspace.

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

## Verification

`pnpm verify` runs lint, typecheck, unit tests, build and end-to-end tests for
every project. `pnpm knip` finds unused files, exports and dependencies. Both
must be green before a commit.

A claim about how a tool behaves is worth what its evidence is worth. Run the
command, read the output, and if the two disagree, the output wins.
