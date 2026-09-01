import { Button } from '@org/shared-ui';

export default function Index() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 data-testid="app-heading" className="text-3xl font-bold tracking-tight">core-web</h1>
      <p className="text-sm text-neutral-500">
        Next.js App Router + Tailwind CSS. API lives at <code>/api</code>.
      </p>
      <Button>Shared design system</Button>
    </main>
  );
}
