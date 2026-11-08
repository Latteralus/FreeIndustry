import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Vite dev server injects stylesheets as inline <style> elements for hot
 * reload, which the production CSP (style-src 'self') rightly forbids. Relax
 * style-src for the dev server only; built output keeps the strict policy.
 */
function devServerStyleCsp(): Plugin {
  return {
    name: 'freeindustry:dev-server-style-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
    },
  };
}

// Main is emitted as ESM ("type": "module"). The preload is forced to CommonJS
// because Electron's sandboxed preload scripts cannot be ES modules.
export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react(), devServerStyleCsp()],
  },
});
