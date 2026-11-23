import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("租户端登出", () => {
  it("登出后回登录页并带 logout=1，用于展示退出确认", async () => {
    const response = await GET(new NextRequest("http://localhost:3001/auth/logout"));
    const location = new URL(response.headers.get("location")!);

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("logout")).toBe("1");
  });
});
