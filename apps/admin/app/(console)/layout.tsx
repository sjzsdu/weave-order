import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ConsoleShell } from "@/src/console-shell";
import { PlatformApiError, currentActor } from "@/src/server-api";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  try {
    const actor = await currentActor();
    return <ConsoleShell actor={actor}>{children}</ConsoleShell>;
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 401) redirect("/login");
    throw error;
  }
}
