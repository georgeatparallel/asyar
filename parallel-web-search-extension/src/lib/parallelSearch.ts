/**
 * Pure request building and response mapping for the Parallel Search API,
 * plus the handler factory registered with Asyar's Web Search Engine SPI.
 *
 * Endpoint: POST https://api.parallel.ai/v1/search
 * Docs: https://docs.parallel.ai/api-reference/search/web
 */
import type {
  INetworkService,
  SearchResultEntry,
  WebSearchQuery,
  WebSearchResult,
} from 'asyar-sdk/contracts';

export const DEFAULT_BASE_URL = 'https://api.parallel.ai';
export const SEARCH_PATH = '/v1/search';

/** Asyar clamps results to the requested limit; mirror its bounds locally. */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 10;
export const DEFAULT_LIMIT = 5;

/** Keep the agent context lean: one excerpt block per result, capped. */
export const MAX_SNIPPET_CHARS = 1200;

/** Asyar falls back to its built-in engine after 10s, so leave IPC headroom. */
export const REQUEST_TIMEOUT_MS = 8000;

/** Guards against pathological queries reaching the API verbatim. */
export const MAX_QUERY_CHARS = 1000;

export const SEARCH_MODES = ['turbo', 'fast', 'basic', 'advanced'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const DEFAULT_MODE: SearchMode = 'fast';

export interface ParallelSearchRequest {
  objective: string;
  search_queries: string[];
  mode: SearchMode;
  max_chars_total: number;
  advanced_settings: { max_results: number };
}

export function resolveMode(value: unknown): SearchMode {
  return typeof value === 'string' && (SEARCH_MODES as readonly string[]).includes(value)
    ? (value as SearchMode)
    : DEFAULT_MODE;
}

export function resolveLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(value)));
}

/**
 * Resolves the POST target. A base URL configured in Settings wins over the
 * public API, which lets users point the engine at a proxy. A base URL that
 * already names a path is used as given.
 */
export function resolveEndpoint(baseUrl?: string): string {
  const candidate = baseUrl?.trim();
  if (!candidate || !/^https?:\/\//i.test(candidate)) {
    return `${DEFAULT_BASE_URL}${SEARCH_PATH}`;
  }
  const trimmed = candidate.replace(/\/+$/, '');
  const hasPath = /^https?:\/\/[^/]+\/.+/i.test(trimmed);
  return hasPath ? trimmed : `${trimmed}${SEARCH_PATH}`;
}

function normalizeQuery(rawQuery: string): string {
  return rawQuery.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

/**
 * Asyar's SPI hands over a single query string, while Parallel takes an
 * `objective` (the information need) plus short keyword `search_queries`,
 * which are required. The agent already writes a search-shaped query, so it
 * becomes the keyword query and is restated as a self-contained objective.
 */
export function buildRequestBody(
  rawQuery: string,
  limit: number,
  mode: SearchMode,
): ParallelSearchRequest {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    throw new Error('Parallel Search received an empty query.');
  }
  return {
    objective: `Find current, reliable web sources that answer: ${query}`,
    search_queries: [query],
    mode,
    max_chars_total: limit * MAX_SNIPPET_CHARS,
    advanced_settings: { max_results: limit },
  };
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function truncateSnippet(text: string, max: number = MAX_SNIPPET_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastBreak = head.lastIndexOf(' ');
  const cut = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}...`;
}

function buildSnippet(excerpts: unknown, publishDate: unknown): string {
  const parts = Array.isArray(excerpts)
    ? excerpts
        .filter((excerpt): excerpt is string => typeof excerpt === 'string')
        .map((excerpt) => excerpt.trim())
        .filter((excerpt) => excerpt.length > 0)
    : [];
  if (typeof publishDate === 'string' && publishDate.trim()) {
    parts.unshift(`Published ${publishDate.trim()}`);
  }
  return truncateSnippet(parts.join('\n\n').replace(/\n{3,}/g, '\n\n'));
}

/**
 * Maps a Parallel Search response onto the SPI shape. Unusable entries are
 * dropped rather than passed through: Asyar sanitizes URLs host side, and a
 * malformed entry would otherwise cost the agent a citation slot.
 */
export function mapResponse(payload: unknown, limit: number): WebSearchResult {
  const rawResults = (payload as { results?: unknown })?.results;
  const entries: SearchResultEntry[] = [];
  const seen = new Set<string>();

  if (Array.isArray(rawResults)) {
    for (const item of rawResults) {
      if (entries.length >= limit) break;
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (!isHttpUrl(record.url)) continue;
      const url = record.url.trim();
      if (seen.has(url)) continue;
      seen.add(url);
      const title =
        typeof record.title === 'string' && record.title.trim()
          ? record.title.trim()
          : hostnameOf(url);
      entries.push({ title, url, snippet: buildSnippet(record.excerpts, record.publish_date) });
    }
  }

  return {
    sources: entries.map(({ title, url }) => ({ title, url })),
    results: entries,
  };
}

function apiErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
      detail?: unknown;
    };
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // Non-JSON error bodies fall through to the status-only message.
  }
  return '';
}

export function formatHttpError(status: number, statusText: string, body: string): string {
  const detail = apiErrorDetail(body);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return `Parallel Search rejected the API key (HTTP ${status}). Update it in Settings > AI > Web Search${suffix}`;
  }
  if (status === 429) {
    return `Parallel Search rate limit reached (HTTP 429). Retry shortly or raise the quota at https://platform.parallel.ai${suffix}`;
  }
  if (status === 422) {
    return `Parallel Search rejected the request (HTTP 422)${suffix}`;
  }
  const reason = statusText ? ` ${statusText}` : '';
  return `Parallel Search failed (HTTP ${status}${reason})${suffix}`;
}

export function buildUserAgent(version: string): string {
  return `Asyar-Parallel-Search/${version} (+https://asyar.org)`;
}

function abortError(): Error {
  return new Error('Parallel Search request was cancelled');
}

/** Rejects as soon as the host aborts, without waiting for the in-flight fetch. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => signal.removeEventListener('abort', onAbort);
    promise.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface ParallelSearchHandlerOptions {
  network: INetworkService;
  /** Read at call time so a changed preference applies to the next search. */
  getMode: () => SearchMode;
  version: string;
}

export function createParallelSearchHandler(options: ParallelSearchHandlerOptions) {
  const { network, getMode, version } = options;

  return async function search(
    query: WebSearchQuery,
    signal: AbortSignal,
  ): Promise<WebSearchResult> {
    if (signal.aborted) throw abortError();

    const apiKey = query.apiKey?.trim();
    if (!apiKey) {
      throw new Error(
        'Parallel Search needs an API key. Add one in Settings > AI > Web Search (create a key at https://platform.parallel.ai).',
      );
    }

    const limit = resolveLimit(query.limit);
    const body = buildRequestBody(query.query, limit, getMode());

    const response = await withAbort(
      network.fetch(resolveEndpoint(query.baseUrl), {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': buildUserAgent(version),
        },
        body: JSON.stringify(body),
        timeout: REQUEST_TIMEOUT_MS,
      }),
      signal,
    );

    if (!response.ok) {
      throw new Error(formatHttpError(response.status, response.statusText, response.body ?? ''));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error('Parallel Search returned a body that is not valid JSON.');
    }

    if (signal.aborted) throw abortError();
    return mapResponse(payload, limit);
  };
}
