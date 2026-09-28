import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",

    /**
     * Pin every data source to mock for the suite.
     *
     * This is not belt-and-braces, it is a correctness requirement. Next.js loads
     * `.env.local` automatically, but vitest does not — so without this the suite
     * would exercise mock data while a developer's running app used live data, and
     * the tests would silently stop reflecting production behaviour. Pinning both
     * sides means a change to the source selection has to be made deliberately in
     * two places rather than drifting.
     *
     * Consequence to remember: no unit test touches the network. The live adapters
     * are tested against recorded fixtures instead, which is also what keeps CI
     * offline and deterministic.
     */
    env: {
      IITTG_SOURCE_WEATHER: "mock",
      IITTG_SOURCE_HOLIDAYS: "mock",
      IITTG_SOURCE_FX: "mock",
      IITTG_SOURCE_FLIGHT: "mock",
      IITTG_SOURCE_HOTEL: "mock",
      // Keep tests from writing cache files into the working tree.
      IITTG_CACHE_DISK: "0",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
