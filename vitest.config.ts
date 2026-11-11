import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist/ holds compiled copies of the tests; running them duplicates every test
    // and can execute stale code.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
