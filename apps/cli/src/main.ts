import { ApiError, EXIT, exitCodeFor } from "./api";
import { flagBool, flagString, parseArgs } from "./args";
import {
  BUILD_INFO,
  CLI_VERSION,
  dataCommand,
  decideCommand,
  doctor,
  login,
  logout,
  skillCommand,
  tokenCommand,
  toolCommand,
  whoami,
} from "./commands";
import type { CliContext } from "./commands";
import { printHelp, USAGE } from "./help";
import { printError, printJson, printLine } from "./output";

const DATA_COMMANDS = new Set(["customers", "samples", "approvals", "panorama", "audit"]);

async function dispatch(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const ctx: CliContext = { json: args.json, serverFlag: flagString(args, "server") };
  const [command, sub] = args.command;

  if (flagBool(args, "version")) {
    printLine(
      `weave ${CLI_VERSION}${BUILD_INFO.commit ? ` (${BUILD_INFO.commit})` : ""}`,
    );
    return EXIT.OK;
  }
  if (flagBool(args, "help") || command === undefined || command === "help") {
    printHelp(command === "help" ? sub : sub === "help" ? undefined : command);
    return EXIT.OK;
  }

  switch (command) {
    case "login":
      return login(args, ctx);
    case "logout":
      return logout(ctx);
    case "whoami":
      return whoami(ctx);
    case "token":
      return tokenCommand(args, sub, ctx);
    case "approve":
      return decideCommand("APPROVE", args, ctx);
    case "reject":
      return decideCommand("REJECT", args, ctx);
    case "tool":
      return toolCommand(args, ctx);
    case "doctor":
      return doctor(ctx);
    case "skill":
      return skillCommand(args, sub, ctx);
    default:
      if (DATA_COMMANDS.has(command)) return dataCommand(command, args, ctx);
      printError(`未知命令：${command}`);
      process.stderr.write(`\n${USAGE}`);
      return EXIT.USAGE;
  }
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json") || argv.includes("-j");
  try {
    return await dispatch(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiError ? error.code : "ERROR";
    if (json) {
      printJson({ ok: false, error: { code, message } });
    } else {
      printError(`✖ ${message}`);
      if (error instanceof ApiError && error.code === "AUTH_REQUIRED") {
        printError("  提示：先执行 weave login，或在环境变量里设置 WEAVE_TOKEN。");
      }
    }
    if (error instanceof ApiError && error.code === "USAGE") return EXIT.USAGE;
    return exitCodeFor(error);
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
