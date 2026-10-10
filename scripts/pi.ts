import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedPiEnvironment } from "./settings.ts";

try {
  // /decision configures an unconfigured launch without guessing Azure identities.
  const environment = installedPiEnvironment();
  const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  // Development launches must not also discover an installed copy of this extension.
  const child = spawn("pi", ["--no-extensions", "--extension", extension, ...process.argv.slice(2)], { env: environment, stdio: "inherit", shell: false });
  child.on("error", () => { console.error("Could not launch pi. Install stock Pi 0.99.2 or newer."); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch {
  console.error("Could not launch installed Pi. Install Pi 0.99.2 or newer, then configure /decision settings.");
  process.exitCode = 1;
}
