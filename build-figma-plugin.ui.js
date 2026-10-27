import { readFileSync } from "node:fs"

const ENVIRONMENTS = {
  production: { apiBase: "https://rerune.io/api", dashboardBase: "https://rerune.io" },
  development: { apiBase: "http://localhost:8080", dashboardBase: "http://localhost:3000" },
}

export default function (buildOptions) {
  const env = process.env.RERUNE_ENV || "production"
  const config = ENVIRONMENTS[env]
  if (config === undefined) {
    throw new Error(`RERUNE_ENV must be "production" or "development", got "${env}"`)
  }
  const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  return {
    ...buildOptions,
    define: {
      ...buildOptions.define,
      __RERUNE_ENV__: JSON.stringify(env),
      __API_BASE__: JSON.stringify(config.apiBase),
      __DASHBOARD_BASE__: JSON.stringify(config.dashboardBase),
      __PLUGIN_VERSION__: JSON.stringify(version),
    },
  }
}
