import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/env";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: resolveDatabaseUrl() },
  strict: true,
  verbose: true,
});
