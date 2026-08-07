import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";

/**
 * Creates the standard 4-build rollup config (ESM, CJS, browser+terser,
 * react-native). All blueprint SDKs use this identical build setup.
 */
export function createRollupConfig({ external = ["@nolag/js-sdk"] } = {}) {
  return [
    // ESM build (Node.js)
    {
      input: "src/index.ts",
      output: { file: "dist/index.mjs", format: "esm", sourcemap: true },
      external,
      plugins: [typescript({ tsconfig: "./tsconfig.json" }), resolve(), commonjs()],
    },
    // CommonJS build (Node.js)
    {
      input: "src/index.ts",
      output: { file: "dist/index.cjs", format: "cjs", sourcemap: true },
      external,
      plugins: [typescript({ tsconfig: "./tsconfig.json" }), resolve(), commonjs()],
    },
    // Browser build (minified)
    {
      input: "src/browser.ts",
      output: { file: "dist/browser.js", format: "esm", sourcemap: true },
      external,
      plugins: [typescript({ tsconfig: "./tsconfig.json" }), resolve({ browser: true }), commonjs(), terser()],
    },
    // React Native build (not minified: Metro minifies release bundles itself,
    // and shipping unminified keeps stack traces and the debugger useful)
    {
      input: "src/react-native.ts",
      output: { file: "dist/react-native.js", format: "esm", sourcemap: true },
      external,
      plugins: [typescript({ tsconfig: "./tsconfig.json" }), resolve({ browser: true }), commonjs()],
    },
  ];
}
