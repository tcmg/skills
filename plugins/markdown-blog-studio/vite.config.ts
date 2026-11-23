import path from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'ui'),
  plugins: [
    viteSingleFile({
      outputFileName: 'editor.html'
    })
  ],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022'
  }
});
