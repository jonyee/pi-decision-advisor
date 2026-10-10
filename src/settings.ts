import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "./config.ts";

export interface DecisionSettingsOptions {
  agentDir?: string;
  projectTrusted?: boolean;
}

const SETTINGS_FILE = "decision-advisor.json";

async function readPreferences(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw new Error("Decision preferences could not be read. Check the preference file permissions.");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Decision preferences must contain a valid JSON object; raw file contents are suppressed."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Decision preferences must contain a JSON object.");
  }
  return value as Record<string, unknown>;
}

function userSettingsPath(options: DecisionSettingsOptions): string {
  return join(resolve(options.agentDir ?? getAgentDir()), SETTINGS_FILE);
}

async function projectPreferences(cwd: string, options: DecisionSettingsOptions): Promise<Record<string, unknown>> {
  return options.projectTrusted === true ? readPreferences(join(resolve(cwd), ".pi", SETTINGS_FILE)) : {};
}
function normalizeStoredPreferences(raw: Record<string, unknown>): DecisionSettings {
  try { return normalizeDecisionSettings(raw); }
  catch { throw new Error("Decision preferences contain invalid fields or unsupported reviewer tools. Open /decision settings to save valid preferences; raw values are suppressed."); }
}


/** Project preferences are ignored unless the caller explicitly supplies project trust. */
export async function loadDecisionSettings(cwd: string, options: DecisionSettingsOptions = {}): Promise<DecisionSettings> {
  const user = await readPreferences(userSettingsPath(options));
  const project = await projectPreferences(cwd, options);
  return normalizeStoredPreferences({ ...user, ...project });
}

/** Atomically save validated user preferences only; never modify project overrides or credentials. */
export async function saveDecisionSettings(cwd: string, settings: DecisionSettings, options: DecisionSettingsOptions = {}): Promise<DecisionSettings> {
  const normalized = normalizeDecisionSettings({ ...settings });
  if (normalized.endpoint || normalized.deployment) toDecisionOptions(normalized);
  // Reject invalid trusted overrides before committing a preference update.
  normalizeStoredPreferences({ ...normalized, ...await projectPreferences(cwd, options) });
  const target = userSettingsPath(options);
  if (target === join(resolve(cwd), ".pi", SETTINGS_FILE)) {
    throw new Error("The Pi agent directory must not target the project override file; project preferences are read-only.");
  }
  const directory = resolve(options.agentDir ?? getAgentDir());
  const temporary = join(directory, `.${SETTINGS_FILE}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch {
    throw new Error("Decision preferences could not be saved. Check the user preference directory permissions.");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return loadDecisionSettings(cwd, options);
}
