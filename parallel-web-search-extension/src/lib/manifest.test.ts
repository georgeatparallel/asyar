import { describe, expect, it } from 'vitest';
import manifest from '../../manifest.json';
import { SEARCH_MODES } from './parallelSearch';

describe('manifest contract', () => {
  it('declares what the Web Search Engine SPI requires', () => {
    expect(manifest.permissions).toContain('network');
    expect(manifest.permissions).toContain('ai:web-search');
    expect(manifest.background.main).toBe('dist/worker.js');
  });

  it('declares a single engine whose id matches the worker registration', () => {
    expect(manifest.webSearchEngines).toHaveLength(1);
    const engine = manifest.webSearchEngines[0];
    expect(engine.id).toBe('parallel');
    expect(engine.id).toMatch(/^[a-z0-9_-]{1,64}$/);
    expect(engine.requiresApiKey).toBe(true);
    expect(engine.apiKeyHelpUrl).toBe('https://platform.parallel.ai');
  });

  it('only offers search modes the API accepts', () => {
    const modePref = manifest.preferences.find((pref) => pref.name === 'mode');
    expect(modePref).toBeDefined();
    const offered = modePref?.data?.map((option) => option.value) ?? [];
    expect(offered.length).toBeGreaterThan(0);
    for (const value of offered) {
      expect(SEARCH_MODES).toContain(value as (typeof SEARCH_MODES)[number]);
    }
    expect(offered).toContain(modePref?.default);
  });
});
