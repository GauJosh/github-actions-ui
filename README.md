# GitHub Actions UI

A browser-only, read-only tool for triaging failed GitHub Actions runs. GitHub stays the source of truth: the app reads runs, jobs and logs through GitHub's REST API and never changes anything.

**Status:** choose a repository, browse and filter its workflow runs, and open a run as an interactive execution graph built from its jobs and the `needs:` in its workflow file. From any job, see its steps and open its log. The end of the log loads first, then the full log loads in a Web Worker, with search and line links. A run URL still works as a shortcut. See [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Requirements

- Node.js 22.12 or later (the fixture scripts use Node's built-in TypeScript support, available from 22.18)
- npm
- Chromium for end-to-end tests: `npx playwright install chromium`

## Setup

```bash
npm ci
npm run fixtures:fetch     # downloads the pinned test fixtures (see below)
npm run dev                # http://localhost:5173
```

## Using the app

**Demo data (fixture mode).** Open `http://localhost:5173/?mode=fixtures`, or choose "explore with demo data" on the connect screen.
- Fixture mode exists only in the dev server, unit tests and the Playwright test build. Production builds (`npm run build`) compile it out entirely; there, `?mode=fixtures` shows "not available in this build" and makes no request.
- A banner marks the mode.
- Data comes from the pinned fixture corpus, served locally. No request goes to GitHub, and no token is used.

**Live GitHub.** Paste a fine-grained personal access token. The suggested permissions are provisional: Actions: Read, Contents: Read and Metadata: Read.
- The token is held in memory only, never stored, and never put in a URL.
- Reloading the page or choosing Disconnect forgets it.
- The app only issues GET and HEAD requests.

## Fixtures

Tests and fixture mode use the [`gha-ui-fixtures`](https://github.com/GauJosh/gha-ui-fixtures) corpus.

**Pinning.** `fixtures.lock.json` pins the corpus to one full 40-character commit SHA and records every file's size and SHA-256. Branch names are rejected as the pin.

**Fetching** (`npm run fixtures:fetch`):
- Downloads each file at that commit from `raw.githubusercontent.com` into `.fixtures/<commit>/`, which Git ignores. No credentials are sent.
- Checks each file's size and SHA-256 before it is moved into place.
- Any mismatch, missing file or HTTP error stops the script with a non-zero exit and an explicit message. No partial file is left behind.
- Re-running it skips files that are already present and correct.

**Offline development.** Either:
- run `npm run fixtures:fetch` once while online; afterwards no network is needed, because the dev server and tests only read `.fixtures/`; or
- copy from a local clone that contains the pinned commit: `npm run fixtures:fetch -- --from ../gha-ui-fixtures`. Files are read at the pinned commit, not the clone's checked-out branch, and every SHA-256 is still checked.

**When fixtures are missing or altered:**
- the fixture server answers "Fixtures not prepared";
- the end-to-end tests fail at setup.

Nothing is skipped silently.

**Re-pinning** is deliberate, and its diff is reviewed:

```bash
npm run fixtures:lock -- --commit <full-40-char-sha> --from ../gha-ui-fixtures
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server (no CSP; its hot-reload client needs inline scripts) |
| `npm run build` | Typecheck and production build |
| `npm run preview` | Serves the production build (`dist/`) with the production Content Security Policy. It has no fixture routes |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including module-boundary rules |
| `npm test` | Unit and contract tests (Vitest; GitHub is mocked with MSW). A global guard (`tests/unit/network-guard.ts`) blocks every outbound connection at the socket layer, so an unmocked request fails before connecting, whatever its host, IP address or proxy setting. The suite also builds the production bundle and checks it contains no fixture-mode code |
| `npm run e2e` | Playwright (Chromium) against a fixture-enabled test build (`GHA_UI_FIXTURES=1`, built to `dist-fixtures/`, never to `dist/`). The browser cannot resolve any non-local host |

## Integrity wording

The app checks that a download is **complete**: the byte count matches the size GitHub reported, and the byte ranges join up with no gaps or overlaps. That is not cryptographic verification. GitHub publishes no checksum for logs, so live log content cannot be authenticated by the client. The CRC32 shown under Diagnostics is used only to compare fixture logs with known values in tests.

## License

[Apache-2.0](LICENSE)
