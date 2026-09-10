/**
 * Nothing but a pass-through.
 *
 * Each credential screen supplies its own title, description and footer to
 * `AuthShell`, and a layout cannot be told what those are — so the frame is a
 * component the pages render rather than something wrapped around them.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
