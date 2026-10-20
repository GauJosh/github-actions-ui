// Fixture-mode banner. Rendered only behind __FIXTURE_MODE__, so production bundles do not include it.
export function FixtureBanner() {
  return (
    <div className="banner" role="note" data-testid="fixture-banner">
      Demo data (fixture mode): runs come from the pinned fixture corpus and from runs marked [synthetic]. No requests go to GitHub.{" "}
      <a href="./">Exit demo</a>
    </div>
  );
}
