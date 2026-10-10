import { delimiter, resolve } from "node:path";
import type { DecisionSettings } from "../src/config.js";
import { loadDecisionSettings, type DecisionSettingsOptions } from "../src/settings.ts";

export class SettingsSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsSetupError";
  }
}

/** Prefer the installed Pi CLI to npm's injected package-local executable directory. */
export function installedPiEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  environment.PATH = (environment.PATH ?? "").split(delimiter)
    .filter(directory => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(directory)).join(delimiter);
  return environment;
}

function settingsContext(args: readonly string[]): { cwd: string; options: DecisionSettingsOptions } {
  let cwd = process.cwd();
  const options: DecisionSettingsOptions = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--trust-project") {
      options.projectTrusted = true;
      continue;
    }
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (flag !== "--agent-dir" && flag !== "--cwd") {
      throw new SettingsSetupError("Probe accepts --cwd <directory>, --agent-dir <directory> and --trust-project; use the same project and Pi agent directory as your Pi launch.");
    }
    const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
    if (!value || value.startsWith("--")) {
      throw new SettingsSetupError("Provide a directory value for --cwd or --agent-dir.");
    }
    if (flag === "--agent-dir") options.agentDir = resolve(process.cwd(), value);
    else cwd = resolve(process.cwd(), value);
  }
  return { cwd, options };
}

/** Read extension-owned preferences directly; project files require explicit trust. */
export async function readStoredDecisionSettings(args: readonly string[] = []): Promise<DecisionSettings> {
  const { cwd, options } = settingsContext(args);
  try {
    return await loadDecisionSettings(cwd, options);
  } catch {
    throw new SettingsSetupError("Cannot read valid Decision preferences. Open /decision settings in the same Pi agent directory and project to save valid provider, model, threshold and timeout settings. Project overrides are used only with --trust-project; raw settings and diagnostics are suppressed.");
  }
}
