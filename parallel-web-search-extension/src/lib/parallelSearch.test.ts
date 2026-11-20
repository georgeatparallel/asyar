import { describe, expect, it, vi } from 'vitest';
import type { INetworkService, NetworkResponse, RequestOptions } from 'asyar-sdk/contracts';
import {
  buildRequestBody,
  buildUserAgent,
  createParallelSearchHandler,
  DEFAULT_LIMIT,
  DEFAULT_MODE,
  formatHttpError,
  mapResponse,
  MAX_SNIPPET_CHARS,
  resolveEndpoint,
  resolveLimit,
  resolveMode,
  truncateSnippet,
} from './parallelSearch';

type FetchImpl = (url: string, options?: RequestOptions) => Promise<NetworkResponse>;

function okResponse(body: unknown): NetworkResponse {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ok: true,
  };
}

function errorResponse(status: number, statusText: string, body: unknown): NetworkResponse {
  return {
    status,
    statusText,
    headers: {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ok: false,
  };
}

function fakeNetwork(fetchImpl: FetchImpl): INetworkService {
  return { fetch: vi.fn(fetchImpl) } as unknown as INetworkService;
}

function handlerWith(fetchImpl: FetchImpl, mode = DEFAULT_MODE) {
  const network = fakeNetwork(fetchImpl);
  const search = createParallelSearchHandler({
    network,
    getMode: () => mode,
    version: '1.0.0',
  });
  return { network, search };
}

describe('resolveLimit', () => {
  it('falls back to the SPI default for non-numeric input', () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(resolveLimit('8')).toBe(DEFAULT_LIMIT);
    expect(resolveLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
  });

  it('clamps to the range Asyar enforces', () => {
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(3)).toBe(3);
    expect(resolveLimit(42)).toBe(10);
    expect(resolveLimit(4.7)).toBe(4);
  });
});

describe('resolveMode', () => {
  it('accepts documented modes and rejects anything else', () => {
    expect(resolveMode('turbo')).toBe('turbo');
    expect(resolveMode('advanced')).toBe('advanced');
    expect(resolveMode('galaxy')).toBe(DEFAULT_MODE);
    expect(resolveMode(undefined)).toBe(DEFAULT_MODE);
  });
});

describe('resolveEndpoint', () => {
  it('uses the public API by default', () => {
    expect(resolveEndpoint(undefined)).toBe('https://api.parallel.ai/v1/search');
    expect(resolveEndpoint('   ')).toBe('https://api.parallel.ai/v1/search');
    expect(resolveEndpoint('not a url')).toBe('https://api.parallel.ai/v1/search');
  });

  it('appends the search path to a bare origin and keeps an explicit path', () => {
    expect(resolveEndpoint('https://proxy.example.com')).toBe(
      'https://proxy.example.com/v1/search',
    );
    expect(resolveEndpoint('https://proxy.example.com/')).toBe(
      'https://proxy.example.com/v1/search',
    );
    expect(resolveEndpoint('https://proxy.example.com/gateway/v1/search')).toBe(
      'https://proxy.example.com/gateway/v1/search',
    );
  });
});

describe('buildRequestBody', () => {
  it('sends the required keyword query plus an objective and the result bound', () => {
    const body = buildRequestBody('  rust   1.90 release   notes ', 3, 'fast');
    expect(body.search_queries).toEqual(['rust 1.90 release notes']);
    expect(body.objective).toContain('rust 1.90 release notes');
    expect(body.mode).toBe('fast');
    expect(body.advanced_settings).toEqual({ max_results: 3 });
    expect(body.max_chars_total).toBe(3 * MAX_SNIPPET_CHARS);
  });

  it('rejects an empty query instead of calling the API', () => {
    expect(() => buildRequestBody('   ', 5, 'fast')).toThrow(/empty query/i);
  });
});

describe('mapResponse', () => {
  const payload = {
    results: [
      {
        url: 'https://parallel.ai/products/search',
        title: 'Parallel Search',
        publish_date: '2026-01-15',
        excerpts: ['First excerpt.', 'Second excerpt.'],
      },
      {
        url: 'https://example.com/no-title',
        title: null,
        excerpts: ['Body text only.'],
      },
    ],
  };

  it('maps results and sources onto the SPI shape', () => {
    const result = mapResponse(payload, 5);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: 'Parallel Search',
      url: 'https://parallel.ai/products/search',
      snippet: 'Published 2026-01-15\n\nFirst excerpt.\n\nSecond excerpt.',
    });
    expect(result.sources).toEqual([
      { title: 'Parallel Search', url: 'https://parallel.ai/products/search' },
      { title: 'example.com', url: 'https://example.com/no-title' },
    ]);
  });

  it('honors the limit, drops duplicates and rejects non-http URLs', () => {
    const result = mapResponse(
      {
        results: [
          { url: 'https://a.example/1', excerpts: ['a'] },
          { url: 'https://a.example/1', excerpts: ['duplicate'] },
          { url: 'javascript:alert(1)', excerpts: ['dangerous'] },
          { url: 42, excerpts: ['not a string'] },
          { url: 'https://b.example/2', excerpts: ['b'] },
          { url: 'https://c.example/3', excerpts: ['c'] },
        ],
      },
      2,
    );
    expect(result.results.map((entry) => entry.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ]);
  });

  it('returns empty collections for a malformed payload', () => {
    expect(mapResponse(null, 5)).toEqual({ sources: [], results: [] });
    expect(mapResponse({ results: 'nope' }, 5)).toEqual({ sources: [], results: [] });
  });

  it('caps long excerpts', () => {
    const long = 'word '.repeat(2000);
    const result = mapResponse({ results: [{ url: 'https://a.example/1', excerpts: [long] }] }, 1);
    expect(result.results[0].snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 3);
    expect(result.results[0].snippet.endsWith('...')).toBe(true);
  });
});

describe('truncateSnippet', () => {
  it('leaves short text untouched', () => {
    expect(truncateSnippet('short text', 100)).toBe('short text');
  });
});

describe('formatHttpError', () => {
  it('explains an auth failure and points at Settings', () => {
    const message = formatHttpError(401, 'Unauthorized', '{"error":{"message":"invalid key"}}');
    expect(message).toContain('HTTP 401');
    expect(message).toContain('Settings > AI > Web Search');
    expect(message).toContain('invalid key');
  });

  it('reads the flat message shape the auth error returns', () => {
    expect(
      formatHttpError(401, 'Unauthorized', '{"code":16,"message":"Invalid API key (C.1)"}'),
    ).toContain('Invalid API key (C.1)');
  });

  it('labels rate limits and validation errors', () => {
    expect(formatHttpError(429, 'Too Many Requests', '')).toContain('rate limit');
    expect(
      formatHttpError(422, 'Unprocessable Entity', '{"error":{"message":"bad body"}}'),
    ).toContain('bad body');
  });

  it('falls back to the status line for non-JSON bodies', () => {
    expect(formatHttpError(503, 'Service Unavailable', '<html>down</html>')).toBe(
      'Parallel Search failed (HTTP 503 Service Unavailable)',
    );
  });
});

describe('createParallelSearchHandler', () => {
  const samplePayload = {
    search_id: 'search_1',
    results: [{ url: 'https://parallel.ai/', title: 'Parallel', excerpts: ['Excerpt.'] }],
  };

  it('posts the documented request with the API key and an Asyar User-Agent', async () => {
    let seenUrl = '';
    let seenOptions: RequestOptions | undefined;
    const { search } = handlerWith(async (url, options) => {
      seenUrl = url;
      seenOptions = options;
      return okResponse(samplePayload);
    }, 'turbo');

    const result = await search(
      { query: 'parallel web systems funding', limit: 3, apiKey: 'test-key' },
      new AbortController().signal,
    );

    expect(seenUrl).toBe('https://api.parallel.ai/v1/search');
    expect(seenOptions?.method).toBe('POST');
    expect(seenOptions?.headers?.['x-api-key']).toBe('test-key');
    expect(seenOptions?.headers?.['User-Agent']).toBe(buildUserAgent('1.0.0'));
    expect(seenOptions?.timeout).toBeGreaterThan(0);
    expect(JSON.parse(seenOptions?.body ?? '{}')).toMatchObject({
      search_queries: ['parallel web systems funding'],
      mode: 'turbo',
      advanced_settings: { max_results: 3 },
    });
    expect(result.results).toHaveLength(1);
    expect(result.sources[0]?.url).toBe('https://parallel.ai/');
  });

  it('asks for an API key before touching the network', async () => {
    const fetchImpl = vi.fn(async () => okResponse(samplePayload));
    const { search } = handlerWith(fetchImpl);

    await expect(
      search({ query: 'anything', limit: 5, apiKey: '  ' }, new AbortController().signal),
    ).rejects.toThrow(/needs an API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces API failures as actionable errors', async () => {
    const { search } = handlerWith(async () =>
      errorResponse(401, 'Unauthorized', '{"error":{"message":"invalid key"}}'),
    );

    await expect(
      search({ query: 'anything', limit: 5, apiKey: 'bad-key' }, new AbortController().signal),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('rejects a body that is not JSON', async () => {
    const { search } = handlerWith(async () => okResponse('<html>nope</html>'));

    await expect(
      search({ query: 'anything', limit: 5, apiKey: 'key' }, new AbortController().signal),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it('does not call the API when the host aborted first', async () => {
    const fetchImpl = vi.fn(async () => okResponse(samplePayload));
    const { search } = handlerWith(fetchImpl);
    const controller = new AbortController();
    controller.abort();

    await expect(
      search({ query: 'anything', limit: 5, apiKey: 'key' }, controller.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects as soon as the host aborts an in-flight request', async () => {
    const controller = new AbortController();
    const { search } = handlerWith(
      () =>
        new Promise<NetworkResponse>((resolve) => {
          setTimeout(() => resolve(okResponse(samplePayload)), 5000);
        }),
    );

    const pending = search({ query: 'anything', limit: 5, apiKey: 'key' }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});
