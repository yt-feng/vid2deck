import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'directory-index-pages',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?')[0];
          const page = path === '/sponsor/' ? 'sponsor' : path === '/admin/' ? 'admin' : '';
          if (!page) {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(readFileSync(resolve(process.cwd(), `public/${page}/index.html`), 'utf-8'));
        });
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
