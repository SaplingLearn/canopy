import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: { "@shared": path.join(__dirname, "..", "shared") },
  },
});
