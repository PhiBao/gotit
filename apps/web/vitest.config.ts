import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Resolve workspace packages to their SOURCE, not their built dist.
 *
 * This config exists because of a real failure. `@gotit/shared` resolves through
 * its package.json `exports` to `dist/paygap.js`. The web tests ran against a
 * dist built a week earlier, so they validated stale engine code while the source
 * had moved on — a bug that lived in the source was invisible to the entire web
 * suite. 40 tests passed against the old engine.
 *
 * Two things make this work beyond a plain alias:
 *
 *  1. The shared source imports itself as `./index.js`, an extension Node's
 *     resolver will not find (the file is `index.ts`). `tsc` accepts it because
 *     the package uses `moduleResolution: bundler`. `sourceExtPlugin` rewrites
 *     the extension so Vitest's resolver finds the `.ts` file.
 *  2. Alias order. A bare-package alias placed before a subpath alias would
 *     swallow the subpaths, so the specific entries come first. The contract
 *     package's vitest config has the same hazard, and it bit there.
 */
/**
 * Absolute path to a file in this app, from the config's own location.
 *
 * `import.meta.url` inside a config that Vite loads is reliable; `process.cwd()`
 * is not, because `pnpm --filter` runs vitest from the package dir but a bare
 * `pnpm test` from the repo root does not.
 */
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));


/** Rewrite relative `./x.js` imports to `./x.ts` so `.ts` sources resolve. */
function sourceExtPlugin(): Plugin {
  return {
    name: "source-extension-to-ts",
    enforce: "pre",
    resolveId(source: string, importer: string | undefined) {
      if (!importer) return null;
      // Only rewrite the workspace's own src files, never node_modules.
      if (!importer.includes("/packages/shared/src/")) return null;
      if (!source.startsWith(".") || !source.endsWith(".js")) return null;
      const target = new URL(source.slice(0, -3) + ".ts", `file://${importer}`);
      return target.pathname;
    },
  };
}

export default defineConfig({
  plugins: [sourceExtPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: [
      { find: /^@gotit\/shared\/paygap$/, replacement: src("../../packages/shared/src/paygap.ts") },
      { find: /^@gotit\/shared\/hash$/, replacement: src("../../packages/shared/src/hash.ts") },
      { find: /^@gotit\/shared\/mockLedger$/, replacement: src("../../packages/shared/src/mockLedger.ts") },
      { find: /^@gotit\/shared$/, replacement: src("../../packages/shared/src/index.ts") },
    ],
  },
});
