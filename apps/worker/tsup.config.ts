import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  // общий пакет — исходники TS, собираем его внутрь бандла
  noExternal: ["@e2e/shared"],
});
