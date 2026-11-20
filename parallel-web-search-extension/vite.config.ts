import { defineExtensionConfig } from 'asyar-sdk/vite';
import { fileURLToPath, URL } from 'node:url';

// Worker-only extension: the SDK detects `src/worker.ts` and applies the
// worker-safe build policy. There is no view entry.
export default defineExtensionConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  view: false,
});
