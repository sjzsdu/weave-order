import { useEffect, useState } from "react";
import { IS_H5 } from "./runtime";

/**
 * H5/PWA 安装：不引 Taro PWA 插件，直接注入 manifest + 注册 Service Worker。
 * 小程序 / App 端整段跳过（`TARO_ENV` 分支只在这里出现一次）。
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: InstallPromptEvent | null = null;

export function initPwa(): void {
  if (!IS_H5 || typeof document === "undefined") return;
  const head = document.head;
  const ensure = (selector: string, create: () => HTMLElement) => {
    if (!head.querySelector(selector)) head.appendChild(create());
  };
  ensure('link[rel="manifest"]', () => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "/manifest.json";
    return link;
  });
  ensure('meta[name="theme-color"]', () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#1f6f5c";
    return meta;
  });
  ensure('meta[name="apple-mobile-web-app-capable"]', () => {
    const meta = document.createElement("meta");
    meta.name = "apple-mobile-web-app-capable";
    meta.content = "yes";
    return meta;
  });
  ensure('link[rel="apple-touch-icon"]', () => {
    const link = document.createElement("link");
    link.rel = "apple-touch-icon";
    link.href = "/icons/icon-192.png";
    return link;
  });

  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    window.dispatchEvent(new Event("weave:installable"));
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    window.dispatchEvent(new Event("weave:installable"));
  });
}

export interface InstallState {
  canInstall: boolean;
  installed: boolean;
  install(): Promise<"accepted" | "dismissed" | "unavailable">;
}

export function useInstallPrompt(): InstallState {
  const [canInstall, setCanInstall] = useState(Boolean(deferredPrompt));
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (!IS_H5 || typeof window === "undefined") return;
    const refresh = () => setCanInstall(Boolean(deferredPrompt));
    const onInstalled = () => {
      setInstalled(true);
      setCanInstall(false);
    };
    window.addEventListener("weave:installable", refresh);
    window.addEventListener("appinstalled", onInstalled);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    return () => {
      window.removeEventListener("weave:installable", refresh);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return {
    canInstall,
    installed,
    async install() {
      if (!deferredPrompt) return "unavailable";
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        deferredPrompt = null;
        setCanInstall(false);
        setInstalled(true);
      }
      return choice.outcome;
    },
  };
}
