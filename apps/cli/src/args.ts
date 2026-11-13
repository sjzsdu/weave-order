/** 轻量参数解析：子命令 + `--flag value` / `--flag=value` / `--boolean`。 */

export interface ParsedArgs {
  command: string[];
  flags: Map<string, string | boolean>;
  json: boolean;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "version",
  "no-browser",
  "force",
  "yes",
  "include-revoked",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      command.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      const map: Record<string, string> = { h: "help", v: "version", j: "json" };
      flags.set(map[short] ?? short, true);
      continue;
    }
    command.push(arg);
  }

  return {
    command,
    flags,
    json: flags.get("json") === true,
  };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "true";
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 出现在 `--` 之后的参数保持原顺序，便于透传 JSON。 */
export function positionals(args: ParsedArgs): string[] {
  return args.command;
}
