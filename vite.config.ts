import { defineConfig } from 'vite';

export default defineConfig({
  base: '/vid2deck/',
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});
