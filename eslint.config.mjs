import js from "@eslint/js"
import tseslint from "typescript-eslint"
import * as figmaPlugin from "@figma/eslint-plugin-figma-plugins"
import { defineConfig } from "eslint/config"

export default defineConfig(
  { ignores: ["build/**", "manifest.json", "build-figma-plugin.*", "node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/ui/**/*.tsx"],
    languageOptions: { parserOptions: { jsxPragma: "h", jsxFragmentName: "Fragment" } },
  },
  {
    files: ["src/main/**/*.ts", "src/codegen/**/*.ts"],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: "./src/main/tsconfig.json" } },
    plugins: { "@figma/figma-plugins": figmaPlugin },
    rules: { ...figmaPlugin.flatConfigs.recommended.rules },
  },
)
