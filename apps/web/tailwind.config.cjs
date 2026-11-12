/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require("../../packages/ui/tailwind-preset.cjs")],
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
};
