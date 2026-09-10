# Contract: the assistant

A facade over a language model, a vector column, and a retrieval demo that says
what it is.

## The facade is the feature

```ts
await ai.generate({ purpose: 'note.summary', model: 'fast', prompt });
```

Feature code names a **purpose** and a **policy alias**. It never names a
provider and never names a model id.

`fast` and `smart` resolve from configuration, so changing what `smart` means is
a deployment decision rather than a code change and a rebuild — and a call site
that said `claude-sonnet-4-5` would be a call site somebody has to find again
when that model is retired.

`purpose` is not decoration. It is what usage is grouped by, and it is the only
label anybody has when the bill arrives.

**The organization is not a parameter.** It comes from the request the call is
being made for, which is where the quota counter reads it from too. Passing it
would be a second source for one fact, and the two would eventually disagree in
the direction of billing the wrong tenant.

**The provider is never reached from inside a transaction.** The facade opens
one short transaction to read the ceiling, closes it, calls the model, and then
opens another to record what was spent. Wrapping the call instead held a
connection — and its pool slot — for as long as the provider took, against the
rule in [transactions](./transactions.md) that says never to make a network
call inside one. It also could not work: Prisma's interactive transactions time
out after five seconds by default, so an answer slower than that rolled the
metering back with it — tokens spent, and no record that they were.

## Resolved at boot, refused at boot

`AiModule.forRoot()` resolves both aliases when the application is assembled. A
provider named without a key fails the boot with the name of the variable; the
alternative is a 500 on the first request that happens to ask for the alias
nobody configured, which for `smart` might be weeks later.

**`AI_PROVIDER=none` is the shipped default and a real state.** A boilerplate
that demanded an API key to start would be one nobody can clone and run. One
line is logged at boot and every call is refused with the variable's name — the
same shape the erasure role uses.

## Metering rides the counters that already exist

Every call records its tokens against two quota counters:

| Entitlement | For |
| --- | --- |
| `ai.tokens` | the ceiling |
| `ai.tokens:<purpose>` | the breakdown, with no ceiling of its own |

Latency, the resolved model and the alias go to one structured log line.
A counter holds one number per window, and those are not it; Phase 6 is where
that line becomes a metric.

### The ceiling is soft, and that is not a shortcut

- **Before the call**, `usage('ai.tokens', 'monthly')` is read and the call is
  refused if the organization is already at its limit. Nothing is spent to be
  told no.
- **After the call**, `QuotaRepository.record(...)` counts what was actually
  used. `record` and not `consume`: `consume` refuses when the units do not fit
  and writes nothing, which is right for work decided in advance and exactly
  wrong for tokens — they were already spent, and the one case where the count
  matters most is the one where it would be dropped.

So an organization can overshoot by the tokens of the calls already in flight.
That is inherent: a completion's cost is not knowable before it exists, and
reserving a guess would refuse work that fits whenever the guess was high and
protect nothing whenever it was low.

The limit is `AI_MONTHLY_TOKEN_LIMIT`.

### Two things the numbers are not

They are the **SDK's** numbers, not the provider's invoice. A retried call, a
cached prompt or a tool-calling loop may bill differently from what the SDK
reports, so nobody should reconcile a bill against these.

And a **streamed** answer is metered when the stream finishes, because that is
when the usage arrives. A client that disconnects halfway leaves tokens spent
and recorded late or not at all. There is no chunk carrying a number the
provider has not sent yet.

## pgvector

`ai_chunks.embedding` is `vector(1536)`, and Prisma sees it as
`Unsupported("vector(1536)")` — it can neither read nor write the column, and
the ranking operator has no Prisma expression at all. Every statement that
touches it is `$queryRaw`. A `Float[]` would type-check and produce a query that
cannot use the index, which is the worst of both.

### The dimension is a migration, not a setting

`vector(n)` fixes `n` in the column, and every embedding model has its own —
1536, 1024, 768. "Make the model configurable" and "make the dimension
configurable" are not the same sentence: **changing the embedding model is a
migration plus a re-embed of everything already stored.**

1536 is what `text-embedding-3-small` produces. The number lives in the
migration, in `EMBEDDING_DIMENSIONS`, and here — and the repository refuses a
vector of the wrong length before the column does, because the column's error
names neither the chunk nor the model that produced it.

### HNSW, and cosine

The index is HNSW rather than IVFFlat. IVFFlat needs a training pass over a
corpus resembling the real one, and a boilerplate's corpus is empty on the day
it is created — exactly when IVFFlat is at its worst.

The operator class is `vector_cosine_ops` and every query orders by `<=>`. The
two have to agree: `<->` against a cosine index returns the same rows in a
different order and does it with a sequential scan, and nothing says so.

### Tenancy

Row-level security, like every other tenant table. **Measured**: with the
`org_id` predicate removed from the search entirely, the isolation test still
passes — the policy is what enforces it, and the predicate is there so the
planner can use the index that leads with `org_id`.

A vector search that crossed organizations would be the quietest leak in the
system: it returns somebody else's text as context, and the model repeats it in
an answer that reads as entirely normal.

At real volume this wants per-tenant partitioning or pgvector's iterative index
scans; neither is here, and this paragraph is the note that says so.

## The RAG demo is a demo

Ingest → chunk → embed → search → answer, streaming.

**Its retrieval is a plain similarity search.** No reranking, no query
rewriting, no evaluation of whether any of it helps. The chunking is fixed
1,200-character windows with a 150-character overlap — characters, not tokens,
and no respect for headings or sentences. A real ingest does all of those and
measures the result.

It exists to prove the parts connect. Saying so here is what stops it being
copied into a product as though it were one.

What it *is* honest about: the tenant's own passages and nobody else's, tokens
metered against the organization that spent them, an answer that streams rather
than arriving all at once, and citations that come from the search rather than
from the model — so a reader can check them.

When the search finds nothing, no model is asked. A model given no passages
answers from its own memory and sounds exactly as confident, which is the
failure the whole shape exists to avoid.

## The routes

| Route | What it does |
| --- | --- |
| `GET /api/v1/ai/documents` | lists this organization's documents |
| `POST /api/v1/ai/documents` | ingests one: chunk, embed, store |
| `DELETE /api/v1/ai/documents/:id` | removes it; the passages cascade |
| `GET /api/v1/ai/ask?question=…` | a `text/event-stream` answer |

The ask route emits one `citations` event, then a `delta` event per piece of
text, then one `done` event with the token counts.

**Its own stream, not the realtime bus.** The bus is a tenant broadcast: every
browser in the organization would receive somebody else's answer, token by
token. What this borrows from realtime is the shape — a response that stays
open — and nothing else.

### Which refusals are status codes, and which are events

Measured, on this application: a global interceptor turns the handler's result
into an Observable, so Nest commits the SSE headers on the next macrotask.
Anything refused **after real asynchronous work** therefore arrives as an
`error` event on a 200, not as a status code. A rejection raised before the
first `await` is still a microtask and beats the commit.

So:

| Refusal | How it arrives |
| --- | --- |
| not signed in, no organization | 403 |
| no permission | 403 |
| no provider configured | 503 |
| over the token ceiling | an `error` event on a 200 |
| the provider failed | an `error` event on a 200 |

The first three are decided synchronously, before the first `await`, precisely
so they can be status codes. The last two need a database read or a network
call and cannot make that deadline. A client reading this stream must handle the
`error` event; a 200 is not the same as an answer.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `none` (default), `anthropic` or `openai` |
| `AI_API_KEY` | required unless the provider is `none` |
| `AI_BASE_URL` | an OpenAI-compatible endpoint: a gateway, or a local model |
| `AI_MODEL_FAST`, `AI_MODEL_SMART` | what the two aliases resolve to |
| `AI_EMBEDDING_MODEL` | must produce 1,536 dimensions, or it is a migration |
| `AI_EMBEDDING_API_KEY`, `AI_EMBEDDING_BASE_URL` | when embeddings come from somewhere else |
| `AI_MONTHLY_TOKEN_LIMIT` | the soft ceiling, per organization per month |
| `AI_SEARCH_LIMIT` | how many passages a question retrieves |

Embeddings are their own provider decision because Anthropic publishes no
embedding model: a deployment answering with Claude still embeds with something
OpenAI-compatible.

**`AI_BASE_URL` really does mean OpenAI-compatible.** Measured: `openai(id)` in
the SDK targets OpenAI's Responses API at `/v1/responses`, which a gateway,
Ollama, vLLM or LM Studio does not serve. The module uses `openai.chat(id)`, so
what it sends is `/v1/chat/completions` — the endpoint they all speak.

## How it is proven

No test reaches a provider. `ai/test` supplies mock models, which is what makes
the suite fast, deterministic, free and runnable in CI without a key.

- **The facade** — usage read from the model and recorded as the model reported
  it; a refusal before the provider is reached when the ceiling is spent, with
  the mock asserting it was never called; the boundary at `used >= limit`; a
  provider failure surfacing as a 503 and recording nothing.
- **Measured, and it changed the tests**: `MockLanguageModelV3` drops its usage
  on the way through this SDK version, so a suite written against it would
  assert zeros and prove the metering reads nothing. The models are V4.
- **The column** — against a real PostgreSQL with pgvector: a vector round-trips
  with the dimensions it went in with, a near passage ranks above a far one,
  one organization's passages never appear in another's search, and a batch with
  one wrong vector writes none of itself.
- **The demo** — ordering, with spies: embedding happens with **no transaction
  open** — counted, not inferred from the order a spy ran in, which an earlier
  version of that test did and which was true however the code was written —
  permission is checked before any provider is reached, the citations are known
  before a token is generated, and no model is asked when the search found
  nothing.
- **The routes** — end to end against the running service, on a deployment with
  `AI_PROVIDER=none`, which is the shipped default: the listing works without a
  model, every other route refuses with the variable's name, and the refusal is
  a 503 rather than a stack trace.
