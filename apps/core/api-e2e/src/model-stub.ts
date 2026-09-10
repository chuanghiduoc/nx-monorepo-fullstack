import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

/** What the column holds, so the fixtures cannot drift from the migration. */
const DIMENSIONS = 1536;

/** What the stub claims each call cost, so the metering has real numbers. */
const EMBEDDING_TOKENS = 5;
export const STUB_INPUT_TOKENS = 41;
export const STUB_OUTPUT_TOKENS = 7;

/** The words the stub streams back, one delta each. */
export const STUB_ANSWER_PIECES = ['Booked ', 'through ', 'the portal.'];

export interface ModelStub {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/**
 * An OpenAI-compatible provider that answers from this process.
 *
 * The alternative was a suite that reached a real provider — slow, flaky,
 * expensive, and unable to run in CI without a key — or no end-to-end proof at
 * all that the assistant answers over SSE. This is the third option: the real
 * SDK, the real HTTP transport, the real route, and a server that speaks the
 * wire format and always says the same thing.
 *
 * What it deliberately does **not** do is judge the request. It is not a mock
 * with expectations; it is a provider that exists. What the API sends it is
 * asserted, where it matters, by the API's own suites.
 */
export async function startModelStub(): Promise<ModelStub> {
  const server = createServer((request, response) => {
    const url = request.url ?? '';

    void readBody(request).then((body) => {
      if (url.endsWith('/embeddings')) {
        answerEmbeddings(response, body);
        return;
      }

      if (url.endsWith('/chat/completions')) {
        answerChat(response);
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `no route ${url}` } }));
    });
  });

  const port = await listen(server);

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * A vector per input, each one distinct.
 *
 * Distinct because identical vectors would make every passage equally near to
 * every question, and a search that returned them in insertion order would look
 * exactly like a search that ranked them.
 */
function answerEmbeddings(response: ServerResponse, body: string): void {
  const parsed = JSON.parse(body) as { input: string | string[] };
  const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];

  const payload = {
    object: 'list',
    data: inputs.map((value, index) => ({
      object: 'embedding',
      index,
      embedding: vectorFor(value),
    })),
    model: 'stub-embedding',
    usage: {
      prompt_tokens: EMBEDDING_TOKENS * inputs.length,
      total_tokens: EMBEDDING_TOKENS * inputs.length,
    },
  };

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** The answer, streamed the way the provider streams one. */
function answerChat(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const id = 'chatcmpl-stub';

  for (const piece of STUB_ANSWER_PIECES) {
    response.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stub-chat',
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })}\n\n`,
    );
  }

  response.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: STUB_INPUT_TOKENS,
        completion_tokens: STUB_OUTPUT_TOKENS,
        total_tokens: STUB_INPUT_TOKENS + STUB_OUTPUT_TOKENS,
      },
    })}\n\n`,
  );

  response.write('data: [DONE]\n\n');
  response.end();
}

/**
 * A deterministic vector for a piece of text.
 *
 * The first component is derived from the text, so two different strings are
 * different directions and the same string is always the same one. That is
 * enough for a search to have an order worth asserting, and it is not
 * pretending to be an embedding.
 */
function vectorFor(value: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000;
  }

  vector[0] = 1;
  vector[1 + (hash % (DIMENSIONS - 1))] = 0.5;

  return vector;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      resolve(body);
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}
