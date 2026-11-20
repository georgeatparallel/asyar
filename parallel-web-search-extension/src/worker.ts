// worker.ts: Tier 2 worker entry for the Parallel Search extension.
//
// The extension contributes one web search engine through Asyar's Web Search
// Engine SPI. Everything runs headless: the engine is registered on this
// worker's own context at module load, and the host dispatches
// `asyar:webSearch:query` to it during AI conversations.

import { ExtensionContext as WorkerExtensionContext, extensionBridge } from 'asyar-sdk/worker';
import type { Extension, ILogService, INetworkService, IOpenerService } from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import { createParallelSearchHandler, resolveMode } from './lib/parallelSearch';

const ENGINE_ID = 'parallel';
const API_KEY_URL = 'https://platform.parallel.ai';

const workerContext = new WorkerExtensionContext();
workerContext.setExtensionId(manifest.id);

const log = workerContext.getService<ILogService>('log');
const network = workerContext.getService<INetworkService>('network');
const opener = workerContext.getService<IOpenerService>('opener');

class ParallelSearchExtension implements Extension {
  async executeCommand(commandId: string): Promise<unknown> {
    if (commandId === 'get-api-key') {
      await opener.openUrl(API_KEY_URL);
    }
    return undefined;
  }
}

extensionBridge.registerManifest(manifest);
extensionBridge.registerExtensionImplementation(manifest.id, new ParallelSearchExtension());

try {
  workerContext.ai.registerWebSearchEngine({
    id: ENGINE_ID,
    search: createParallelSearchHandler({
      network,
      // Read at call time so a preference change applies to the next search.
      getMode: () => resolveMode(workerContext.preferences.values.mode),
      version: manifest.version,
    }),
  });
  log.info(`[${manifest.id}] registered web search engine: ${ENGINE_ID}`);
} catch (error: unknown) {
  log.error(
    `[${manifest.id}] registerWebSearchEngine failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
