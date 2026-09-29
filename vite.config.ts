import { defineConfig, type Connect } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directoryPages = new Set(['admin', 'sponsor', 'pricing', 'privacy', 'refund', 'terms-and-conditions', 'contact', 'one-time-pass']);

function serveDirectoryPages(middlewares: Connect.Server, root: string): void {
  middlewares.use((request, response, next) => {
    const url = request.url ?? '';
    const queryStart = url.indexOf('?');
    const path = queryStart < 0 ? url : url.slice(0, queryStart);
    const query = queryStart < 0 ? '' : url.slice(queryStart);
    const match = path.match(/^\/([^/]+)\/?$/);
    if (!match || !directoryPages.has(match[1]) || !['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      next();
      return;
    }
    if (!path.endsWith('/')) {
      response.statusCode = 302;
      response.setHeader('Location', `${path}/${query}`);
      response.end();
      return;
    }
    try {
      const html = readFileSync(resolve(root, match[1], 'index.html'), 'utf-8');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : html);
    } catch (error) {
      next(error);
    }
  });
}

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'directory-index-pages',
      configureServer(server) {
        serveDirectoryPages(server.middlewares, server.config.publicDir);
      },
      configurePreviewServer(server) {
        serveDirectoryPages(server.middlewares, resolve(server.config.root, server.config.build.outDir));
      }
    }
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});
