import { defineConfig } from "vitest/config"

export default defineConfig({
  define: {
    __RERUNE_ENV__: JSON.stringify("development"),
    __API_BASE__: JSON.stringify("http://localhost:8080"),
    __DASHBOARD_BASE__: JSON.stringify("http://localhost:3000"),
    __PLUGIN_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
})
