import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  // The app is deployed under https://kumavis.github.io/play-odd-ball/, so all
  // asset URLs must be relative rather than rooted at /.
  base: "./",
  plugins: [preact()],
});
