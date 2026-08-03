/**
 * Phase 0 placeholder. The real dashboard arrives in Phase 3; auth in Phase 2.
 * Kept intentionally minimal — no landing page (see SPEC §7).
 */
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Foreman</h1>
      <p className="max-w-sm text-sm text-neutral-500">
        Voice-driven construction scheduling. Scaffold is up — dashboard, Gantt,
        and voice land in later phases.
      </p>
    </main>
  );
}
