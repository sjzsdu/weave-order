import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 本地开发：页面 5173，API 3000；代理掉跨域，生产由同域网关转发。
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
