import { demoItemsControllerList } from '@workspace/shared-api-client-core';

/**
 * Renders through the generated client rather than a hand-written fetch.
 *
 * That is what makes the contract real: rename a field in the API's Zod DTO,
 * regenerate the client, and this page stops compiling. CI regenerates on
 * every run, so the break cannot be postponed.
 */
export default async function DemoItemsPage() {
  const { data, error } = await demoItemsControllerList();

  if (error || !data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
        <h1 className="text-2xl font-semibold">Demo items</h1>
        <p className="text-sm text-neutral-500">The API is not reachable.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 data-testid="demo-items-heading" className="text-2xl font-semibold">
        Demo items
      </h1>

      <ul data-testid="demo-items" className="w-full max-w-md space-y-2">
        {data.items.map((item) => (
          <li
            key={item.id}
            className="rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
          >
            {item.title}
          </li>
        ))}
      </ul>

      {data.items.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing here yet.</p>
      ) : null}
    </main>
  );
}
