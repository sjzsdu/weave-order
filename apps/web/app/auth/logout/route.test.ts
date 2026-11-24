import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("租户端退出登录", () => {
  it("退出后停留在提示页，不立即重新发起 SSO 登录", async () => {
    vi.stubEnv("WEB_APP_URL", "https://tenant.example.test");

    const response = await GET(new NextRequest("http://localhost:3001/auth/logout"));
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("https://tenant.example.test");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("loggedOut")).toBe("1");
  });
});
