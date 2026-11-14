/**
 * 设计系统 Tailwind preset（product-design §9.1）。
 * 改动必须与 src/tokens.ts 同步；组件只使用这里的语义化类名。
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#14202B",
          700: "#2B3B4A",
          500: "#4E5F6E",
          400: "#7A8896",
        },
        paper: "#F7F4EE",
        "paper-deep": "#EFE9DF",
        surface: "#FFFFFF",
        line: "#E3DED4",
        "line-strong": "#D3CCC0",
        indigo: {
          600: "#1F4E79",
          700: "#173E60",
          100: "#E6EEF5",
        },
        vermilion: {
          600: "#C0492F",
          100: "#FBEDEA",
        },
        moss: {
          600: "#3F6B4F",
          100: "#EAF1EC",
        },
        amber: {
          600: "#B7791F",
          100: "#FBF3E4",
        },
      },
      fontFamily: {
        sans: ['"Inter"', '"PingFang SC"', '"Microsoft YaHei"', "system-ui", "sans-serif"],
        serif: [
          '"Noto Serif SC"',
          '"Noto Serif CJK SC"',
          '"Source Han Serif SC"',
          '"Songti SC"',
          '"SimSun"',
          "Georgia",
          "serif",
        ],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        xs: ["12px", "1.5"],
        sm: ["13px", "1.5"],
        base: ["14px", "1.5"],
        lg: ["16px", "1.4"],
        xl: ["20px", "1.25"],
        "2xl": ["24px", "1.25"],
        "3xl": ["32px", "1.2"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
        pill: "999px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(20, 32, 43, 0.06), 0 1px 3px rgba(20, 32, 43, 0.04)",
      },
    },
  },
};
