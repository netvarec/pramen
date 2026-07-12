import type { Config } from "tailwindcss";
import podobaPreset from "@podoba/tailwind";

// The admin dashboard's design system is podoba.
export default {
  presets: [podobaPreset],
  content: [
    "./src/**/*.{ts,tsx}",
    "./node_modules/@podoba/react/src/**/*.{ts,tsx}",
  ],
} satisfies Config;
