import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // TypeScript 7 broke rollup-plugin-dts (same issue the main temporal-fmt
  // package hits — see its tsup.config.ts comment). Declarations come from
  // a plain `tsc --declaration` pass in the build script instead.
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'esnext',
});
