/**
 * 404. Says what happened and gives one way back; same paper surface and type
 * as the app so a mistyped address does not look like a broken site.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] items-center bg-vellum px-6">
      <div className="max-w-md">
        <p className="font-mono text-xs uppercase tracking-wide text-inkMuted">Error 404</p>
        <h1 className="mt-2 font-serif text-4xl leading-tight text-ink text-balance">
          That page is not on the map.
        </h1>
        <p className="mt-3 text-inkMuted text-pretty">
          The address may be mistyped, or the page may have moved. The question box is on the
          front page.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex min-h-[44px] items-center rounded-md bg-celestial px-4 text-sm font-medium text-onCelestial hover:bg-primaryInk"
        >
          Back to the question box
        </a>
      </div>
    </main>
  );
}
