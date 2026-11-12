const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  // 用绝对路径，避免从不同 cwd 启动时 content 扫描落空。
  content: [path.join(__dirname, "index.html"), path.join(__dirname, "src/**/*.{js,ts,jsx,tsx}")],
  theme: {
    extend: {
      colors: {
        ink: "#0f1216",
        panel: "#171c22",
        line: "#262e38",
        text: "#e7ecf2",
        muted: "#8b97a6",
        accent: "#7bd88f",
        "accent-dark": "#1f3b2a",
        warn: "#f0b35b",
        danger: "#ff7b72",
      },
    },
  },
  plugins: [],
};
