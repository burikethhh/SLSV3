import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        // Per-role code-split: ceo/owner bundles load lazily, login stays tiny
        manualChunks: {
          ceo: ["./src/views/ceo.ts"],
          owner: ["./src/views/owner.ts"],
        },
      },
    },
  },
});
