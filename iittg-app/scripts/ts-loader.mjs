/**
 * Import resolution for running TypeScript directly with Node.
 *
 * Node 22.18+/24 strips types from `.ts` files on its own, which is why the
 * collector CLI needs no build step or bundler. What it does *not* do is guess
 * file extensions: `./cities` is not a valid specifier for the ESM resolver, and
 * the app's source uses extensionless relative imports throughout. This hook adds
 * exactly that — plus the `@/` alias the source uses in tests — and nothing else.
 *
 * Used via:
 *   node --import ./scripts/ts-loader.mjs scripts/crawl-hotel-prices.ts
 * which is what the `crawl:hotels` npm script does.
 *
 * Scope is deliberate: it resolves specifiers, it does not transform code. A file
 * that needs real compilation (decorators, enums, namespaces) will fail loudly
 * rather than half-work, and that is the behaviour we want from a dev-only hook.
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/** Extensions tried, in order, when a specifier has none. */
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Resolves `@/x` against the app's `src/` directory. */
function resolveAlias(specifier) {
  if (!specifier.startsWith("@/")) return null;
  return pathToFileURL(resolvePath(ROOT, "src", specifier.slice(2))).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const aliased = resolveAlias(specifier);

    if (aliased) {
      for (const candidate of [aliased, ...EXTENSIONS.map((ext) => aliased + ext)]) {
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate, shortCircuit: true };
        }
      }
    }

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const hasExtension = /\.[a-z]+$/i.test(specifier);
      if (hasExtension) throw error;

      for (const extension of EXTENSIONS) {
        try {
          return nextResolve(specifier + extension, context);
        } catch {
          // try the next candidate
        }
      }
      throw error;
    }
  },
});
