import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  resolve: {
    // Take ONNX Runtime's build that loads its WebAssembly as a separate file
    // rather than the default, which inlines 13MB of it as base64 into the
    // JavaScript bundle. The .wasm is copied into public/ort/ and pointed at
    // explicitly, so it is served by us and never fetched from a CDN.
    conditions: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // The depth runtime is loaded only when somebody asks for depth, so it
        // has to stay in its own chunk rather than being merged into the entry.
        manualChunks(id) {
          if (id.includes('onnxruntime')) return 'depth-runtime';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
