import type { Config } from "tailwindcss";
import podobaPreset from "@podoba/tailwind";

// The CMS editor's design system is podoba: the preset binds @podoba/tokens CSS
// vars to theme.extend; content scans this app + @podoba/react's shipped source
// (it ships class strings, so Tailwind must see them to generate the utilities).
export default {
  presets: [podobaPreset],
  content: [
    "./src/**/*.{ts,tsx}",
    "./node_modules/@podoba/react/src/**/*.{ts,tsx}",
  ],
} satisfies Config;

