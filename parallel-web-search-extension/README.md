# Parallel Search for Asyar

Grounds Asyar's AI agent in live web results from the
[Parallel Search API](https://docs.parallel.ai/search/search-quickstart). One call returns ranked
pages with long, LLM ready excerpts, which Asyar renders as source pills and citations in the chat.

The extension contributes a search engine through Asyar's
[Web Search Engine SPI](https://github.com/Xoshbin/asyar/blob/main/docs/how-to/contribute-web-search-engine.md).
It has no UI and no commands: a headless worker registers the engine, and the host dispatches
queries to it while an AI conversation is running.

## Setup

1. Install the extension.
2. Create an API key at [platform.parallel.ai](https://platform.parallel.ai). The launcher command
   **Get Parallel API Key** opens that page for you.
3. Open **Settings → AI → Web Search**, pick **Parallel** under Extensions, and paste the key. Asyar
   stores it encrypted on device and passes it to the worker with each query.
4. Optional: **Settings → Extensions → Parallel Search** selects the search mode (`turbo`, `fast`,
   `basic`, `advanced`). The default is `fast`, which keeps chat responsive; `advanced` returns the
   highest quality results and takes longer.

Selecting the engine is the consent step. Nothing is sent to Parallel until the agent runs a web
search, and the only payload is the agent's query string plus your key.

## What is sent and returned

Each search is a single `POST https://api.parallel.ai/v1/search` with the key in the `x-api-key`
header:

```json
{
  "objective": "Find current, reliable web sources that answer: rust 1.90 release notes",
  "search_queries": ["rust 1.90 release notes"],
  "mode": "fast",
  "max_chars_total": 6000,
  "advanced_settings": { "max_results": 5 }
}
```

Parallel requires at least one keyword query, so Asyar's single query string becomes the keyword
query and is restated as a self contained objective. Each response result maps to one SPI entry:
`url`, `title` (falling back to the hostname), and a snippet built from `excerpts`, prefixed with
`Published <date>` when Parallel reports one.

Invariants the handler respects:

- **Limit.** `query.limit` is clamped to 1 to 10, sent as `advanced_settings.max_results`, and
  applied again when mapping, so the host never sees more entries than it asked for.
- **AbortSignal.** An already aborted signal fails before any network call, and an abort during a
  request rejects immediately instead of waiting for the response.
- **Timeout.** Requests use an 8 second timeout, inside the 10 second window after which Asyar falls
  back to its built-in engine.
- **Errors.** Non-2xx responses become actionable messages (missing or invalid key, rate limit,
  rejected request) instead of raw status codes.
- **User-Agent.** Requests identify themselves as `Asyar-Parallel-Search/<version>`.

Only `http:` and `https:` result URLs are kept; duplicates are dropped. Asyar sanitizes URLs host
side as well.

## Development

```bash
pnpm install
pnpm run build        # vite build -> dist/worker.js
pnpm run typecheck
pnpm run test:run
pnpm exec asyar validate
```

Load it into a local Asyar install with `pnpm exec asyar link` (or `asyar attach .`), then restart
the launcher so the worker is mounted and the engine shows up in **Settings → AI → Web Search**.

## Publishing

`asyar publish` validates the manifest, builds, creates a GitHub release for the current commit, and
submits the release to the Asyar Store for review.

## License

MIT. Parallel and the Parallel Search API are products of Parallel Web Systems, Inc.
