import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverDecisionDeployments } from "../src/azure-models.js";
import type { AzureRunner } from "../src/azure-cli.js";
import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_INSTRUCTIONS_BYTES, REVIEW_HOST_WAIT_MS, normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "../src/config.js";
import { ELEVATED_REVIEW_TOOLS, parseReviewTools } from "../src/review-tools.js";
import { loadDecisionSettings, saveDecisionSettings } from "../src/settings.js";
import { configureDecision } from "../src/settings-ui.js";
import { withLoading } from "../src/loading-ui.js";
import { showDecisionStatus } from "../src/status-ui.js";
import { readStoredDecisionSettings } from "../scripts/settings.ts";

const configured: DecisionSettings = {
  enabled: true,
  verbose: false,
  endpoint: "https://example.invalid",
  deployment: "chosen-decision",
  reviewModel: "provider/chosen-advisor",
  credentialMode: "default",
  passThreshold: 0.72,
  timeoutMs: 750,
  advisorTimeoutMs: 1_250,
  reviewTools: "read,grep,find",
  reviewInstructions: "",
  reviewHistoryTurns: 3,
};

test("verbose output is a validated independent preference", () => {
  const saved = normalizeDecisionSettings({ ...configured, verbose: true, enabled: false });
  const restored = normalizeDecisionSettings(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.verbose, true);
  assert.equal(restored.enabled, false);
  assert.equal(normalizeDecisionSettings({ ...restored, verbose: false }).verbose, false);
  for (const verbose of ["true", 1, null]) assert.throws(() => normalizeDecisionSettings({ ...configured, verbose }), /verbose must be a boolean/);
});

test("unconfigured preferences are readable but cannot create scoring options", () => {
  const settings = normalizeDecisionSettings({ endpoint: "", deployment: "", reviewModel: "" });
  assert.equal(settings.reviewModel, "");
  assert.equal(normalizeDecisionSettings({ reviewModel: "   " }).reviewModel, "");
  assert.throws(() => toDecisionOptions(settings), /endpoint and deployment/);
  for (const partial of [{ endpoint: configured.endpoint }, { deployment: configured.deployment }]) {
    assert.throws(() => toDecisionOptions(normalizeDecisionSettings(partial)), /endpoint and deployment/);
  }
  const selected = toDecisionOptions(normalizeDecisionSettings({ ...configured }));
  assert.equal(selected.endpoint, configured.endpoint);
  assert.equal(selected.deployment, configured.deployment);
});

test("disabled automatic review persists while changing threshold and advisor model", () => {
  const disabled = normalizeDecisionSettings({ ...configured, enabled: false });
  const restored = normalizeDecisionSettings(JSON.parse(JSON.stringify(disabled)));
  const tuned = normalizeDecisionSettings({ ...restored, passThreshold: 0.55 });
  const selected = normalizeDecisionSettings({ ...tuned, reviewModel: "provider/alternate-advisor" });
  for (const settings of [disabled, restored, tuned, selected]) {
    assert.equal(settings.enabled, false);
    assert.equal(Object.hasOwn(toDecisionOptions(settings), "enabled"), false);
    assert.equal(settings.enabled, false);
  }
  assert.equal(selected.passThreshold, 0.55);
  assert.equal(selected.reviewModel, "provider/alternate-advisor");
  assert.equal(toDecisionOptions(selected).deployment, configured.deployment);
  assert.equal(toDecisionOptions(selected).credentialMode, configured.credentialMode);
});

test("enabled preferences reject non-boolean stored values", () => {
  for (const enabled of ["true", "false", "", 0, 1, null, [], {}]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, enabled }), /enabled must be a boolean/);
  }
});

test("changing triage tuning preserves explicit advisor and Azure identity choices", () => {
  const tuned = normalizeDecisionSettings({ ...configured, passThreshold: 0.55, timeoutMs: 5_000 });
  assert.equal(tuned.reviewModel, "provider/chosen-advisor");
  assert.equal(toDecisionOptions(tuned).credentialMode, "default");
  const changed = normalizeDecisionSettings({ ...tuned, credentialMode: "azure-cli" });
  assert.equal(changed.reviewModel, configured.reviewModel);
  assert.equal(toDecisionOptions(changed).credentialMode, "azure-cli");
});

test("stored host deadlines and pass probability have bounded numeric semantics", () => {
  for (const passThreshold of [0.5, 1]) {
    assert.equal(toDecisionOptions(normalizeDecisionSettings({ ...configured, passThreshold })).passThreshold, passThreshold);
  }
  for (const passThreshold of [NaN, Infinity, -Infinity, 0.49, 1.01, "0.8", null]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, passThreshold }));
  }
  for (const [key, maximum] of [["timeoutMs", 20_000], ["advisorTimeoutMs", 120_000]] as const) {
    for (const value of [100, maximum]) {
      const settings = normalizeDecisionSettings({ ...configured, [key]: value });
      assert.equal(settings[key], value);
    }
    for (const value of [99, maximum + 1, 100.5, Infinity, NaN, "1000", null]) {
      assert.throws(() => normalizeDecisionSettings({ ...configured, [key]: value }));
    }
  }
  assert.equal(normalizeDecisionSettings({}).advisorTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(normalizeDecisionSettings({ advisorTimeoutMs: 1_250 }).advisorTimeoutMs, 1_250);
  assert.throws(() => toDecisionOptions({ ...configured, timeoutMs: 20_001 }));
});

test("reviewer execution deadlines above the host wait survive saved preference tuning", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-review-deadlines-"));
  try {
    for (const advisorTimeoutMs of [45_000, 60_000, 120_000]) {
      const saved = await saveDecisionSettings(root, { ...configured, advisorTimeoutMs }, { agentDir: root });
      assert.equal(saved.advisorTimeoutMs, advisorTimeoutMs);
      const loaded = await loadDecisionSettings(root, { agentDir: root });
      const tuned = await saveDecisionSettings(root, { ...loaded, passThreshold: 0.95 }, { agentDir: root });
      assert.equal(tuned.advisorTimeoutMs, advisorTimeoutMs);
      assert.equal(JSON.parse(await readFile(join(root, "decision-advisor.json"), "utf8")).advisorTimeoutMs, advisorTimeoutMs);
      assert.equal(toDecisionOptions(tuned).timeoutMs, configured.timeoutMs);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stored provider endpoints reject credentials and non-origin URLs even before deployment selection", () => {
  const endpoints = ["http://example.invalid", "http://127.0.0.1", "ftp://example.invalid", "https://user:password@example.invalid",
    "https://example.invalid/path", "https://example.invalid?key=test", "https://example.invalid#test", "not-a-url"];
  for (const endpoint of endpoints) {
    assert.throws(() => normalizeDecisionSettings({ endpoint, deployment: "" }));
  }
  const normalized = normalizeDecisionSettings({ ...configured, endpoint: " https://example.invalid/ " });
  assert.equal(toDecisionOptions(normalized).endpoint, "https://example.invalid");
  for (const deployment of ["bad/name", "bad name", "x".repeat(129), 123]) {
    assert.throws(() => normalizeDecisionSettings({ endpoint: "", deployment }));
  }
});

test("invalid advisor selectors and unknown credential modes cannot become persisted preferences", () => {
  for (const reviewModel of ["@advisor", "provider", "/model", "provider/", "provider/model name", "provider/model\nprivate", null, 42]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, reviewModel }));
  }
  for (const credentialMode of ["cli", "key", "", null]) {
    assert.throws(() => normalizeDecisionSettings({ ...configured, credentialMode }));
  }
});

test("reviewer tools normalize comma and whitespace grants in deterministic supported order", () => {
  assert.deepEqual(parseReviewTools(" FIND, READ grep,read\nGrep\tfind "), ["read", "grep", "find"]);
  assert.equal(normalizeDecisionSettings({ reviewTools: "write, BASH, read,read" }).reviewTools, "read,bash,write");
});

test("empty reviewer grants remain empty across normalization and preference round trips", () => {
  for (const reviewTools of ["", "  ", ", ,\n\t"]) {
    const settings = normalizeDecisionSettings({ ...configured, reviewTools });
    assert.equal(settings.reviewTools, "");
    assert.deepEqual(parseReviewTools(settings.reviewTools), []);
    assert.equal(normalizeDecisionSettings(JSON.parse(JSON.stringify(settings))).reviewTools, "");
  }
});

test("unknown and non-string reviewer grants cannot become persisted preferences", () => {
  for (const reviewTools of ["glob", "recall", "lsp", "web_search", "eval", "ast_edit", "debug", "task", "spawn", "mcp", "custom_tool", "read,unknown", "read;bash", null, 0, ["read"], {}]) {
    assert.throws(() => normalizeDecisionSettings({ reviewTools }));
  }
  assert.throws(() => parseReviewTools("READ task"));
});

test("saved reviewer preferences survive triage changes without granting additional tools", () => {
  const preferences = normalizeDecisionSettings({
    ...configured,
    reviewTools: "ls,read,find",
    reviewInstructions: "  Check evidence.\n\tExplain uncertainty.\r\n",
    reviewHistoryTurns: 8,
  });
  const restored = normalizeDecisionSettings(JSON.parse(JSON.stringify(preferences)));
  const changed = normalizeDecisionSettings({ ...restored, passThreshold: 0.9, reviewModel: "provider/alternate-reviewer" });
  assert.equal(changed.reviewTools, "read,find,ls");
  assert.equal(changed.reviewInstructions, preferences.reviewInstructions);
  assert.equal(changed.reviewHistoryTurns, 8);
  assert.equal(parseReviewTools(changed.reviewTools).some(tool => ELEVATED_REVIEW_TOOLS.includes(tool)), false);
  const scoring = toDecisionOptions(changed);
  for (const key of ["reviewTools", "reviewInstructions", "reviewHistoryTurns"]) assert.equal(Object.hasOwn(scoring, key), false);
});

test("review history preferences accept only integers from zero through eight", () => {
  for (let reviewHistoryTurns = 0; reviewHistoryTurns <= 8; reviewHistoryTurns++) {
    assert.equal(normalizeDecisionSettings({ reviewHistoryTurns }).reviewHistoryTurns, reviewHistoryTurns);
  }
  for (const reviewHistoryTurns of [-1, 9, 0.5, 3.1, NaN, Infinity, -Infinity, "3", null, false, []]) {
    assert.throws(() => normalizeDecisionSettings({ reviewHistoryTurns }));
  }
});

test("reviewer instructions preserve multiline content and enforce UTF-8 byte boundaries", () => {
  for (const reviewInstructions of ["", " \t\n\r ", "x".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES), "é".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 2), "😀".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 4)]) {
    assert.equal(normalizeDecisionSettings({ reviewInstructions }).reviewInstructions, reviewInstructions);
  }
  for (const reviewInstructions of ["x".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES + 1), "é".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 2 + 1), "😀".repeat(MAX_REVIEW_INSTRUCTIONS_BYTES / 4 + 1), null, 42, []]) {
    assert.throws(() => normalizeDecisionSettings({ reviewInstructions }));
  }
});

test("reviewer instructions reject forbidden controls without scanning ordinary content", () => {
  for (const control of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f", "\u007f", "\u0085", "\u009f"]) {
    assert.throws(() => normalizeDecisionSettings({ reviewInstructions: `${control}text${control}` }), /control characters/);
  }
  const reviewInstructions = "Review names such as token, password and credential as ordinary text.";
  assert.equal(normalizeDecisionSettings({ reviewInstructions }).reviewInstructions, reviewInstructions);
});

test("Azure model selection offers only healthy existing Decision-1 deployments", async () => {
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return [
      { name: "healthy-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } },
      { name: "unhealthy-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Failed", endpoint: configured.endpoint } },
      { name: "other-kind-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "OpenAI", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } },
    ] as T;
    return [
      { name: "selected", properties: { provisioningState: "Succeeded", model: { name: "Microsoft-Decision-1", format: "Microsoft", version: "fixture" } } },
      { name: "unhealthy", properties: { provisioningState: "Failed", model: { name: "Microsoft-Decision-1", format: "Microsoft" } } },
      { name: "wrong-model", properties: { provisioningState: "Succeeded", model: { name: "Other", format: "Microsoft" } } },
      { name: "wrong-format", properties: { provisioningState: "Succeeded", model: { name: "Microsoft-Decision-1", format: "Other" } } },
    ] as T;
  };
  const choices = await discoverDecisionDeployments(run);
  assert.deepEqual(choices.map(choice => choice.deployment), ["selected"]);
  assert.equal(choices[0]?.location, "region-fixture");
  assert.equal(choices[0]?.model, "Microsoft-Decision-1");
});

test("deployment discovery can use readable accounts when another account denies cloud reads", async () => {
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return ["denied", "readable"].map(name => ({ name, resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } })) as T;
    if (args[args.indexOf("--name") + 1] === "denied") throw new Error("denied fixture");
    return [{ name: "available", properties: { provisioningState: "Succeeded", model: { name: "Microsoft-Decision-1", format: "Microsoft" } } }] as T;
  };
  assert.deepEqual((await discoverDecisionDeployments(run)).map(choice => choice.deployment), ["available"]);
});

test("denied Azure discovery does not leak account metadata", async () => {
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return [{ name: "account-fixture", resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } }] as T;
    throw new Error("private-fixture-marker");
  };
  await assert.rejects(discoverDecisionDeployments(run), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("private-fixture-marker"), false);
    return true;
  });
});

test("cancelled discovery does not begin cloud access", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const run: AzureRunner = async <T>(): Promise<T> => { calls++; throw new Error("Unexpected cloud access"); };
  await assert.rejects(discoverDecisionDeployments(run, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("cancellation during an account read never becomes a partial deployment list", async () => {
  const controller = new AbortController();
  const visited: string[] = [];
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    if (args[2] === "list") return ["first", "second"].map(name => ({ name, resourceGroup: "group-fixture", location: "region-fixture", kind: "AIServices", properties: { provisioningState: "Succeeded", endpoint: configured.endpoint } })) as T;
    visited.push(args[args.indexOf("--name") + 1]!);
    controller.abort();
    throw new Error("Aborted cloud read");
  };
  await assert.rejects(discoverDecisionDeployments(run, controller.signal), { name: "AbortError" });
  assert.deepEqual(visited, ["first"]);
});

test("cancellation while listing accounts does not report no deployments", async () => {
  const controller = new AbortController();
  const run: AzureRunner = async <T>(args: string[]): Promise<T> => {
    if (args[0] === "account") return { id: "subscription-fixture", state: "Enabled" } as T;
    controller.abort();
    return [] as T;
  };
  await assert.rejects(discoverDecisionDeployments(run, controller.signal), { name: "AbortError" });
});

test("user saves persist validated fields privately and return trusted project overrides without rewriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-preferences-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectFile = join(cwd, ".pi", "decision-advisor.json");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const projectText = JSON.stringify({ enabled: false, passThreshold: 0.91, reviewModel: "provider/project-reviewer" });
    await writeFile(projectFile, projectText);
    const candidate = { ...configured, reviewInstructions: " First line\n\tSecond line ", accessToken: "fixture-not-a-preference" };
    const effective = await saveDecisionSettings(cwd, candidate, { agentDir, projectTrusted: true });
    assert.equal(effective.enabled, false);
    assert.equal(effective.passThreshold, 0.91);
    assert.equal(effective.reviewModel, "provider/project-reviewer");
    assert.equal(effective.reviewInstructions, candidate.reviewInstructions);
    assert.equal(await readFile(projectFile, "utf8"), projectText);
    const storedPath = join(agentDir, "decision-advisor.json");
    const stored = JSON.parse(await readFile(storedPath, "utf8"));
    assert.deepEqual(stored, normalizeDecisionSettings(candidate));
    assert.equal(Object.hasOwn(stored, "accessToken"), false);
    if (process.platform !== "win32") assert.equal((await stat(storedPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(agentDir), ["decision-advisor.json"]);
    assert.deepEqual(await loadDecisionSettings(cwd, { agentDir }), normalizeDecisionSettings(candidate));
    assert.deepEqual(await readStoredDecisionSettings(["--cwd", cwd, "--agent-dir", agentDir]), normalizeDecisionSettings(candidate));
    assert.deepEqual(await readStoredDecisionSettings([`--cwd=${cwd}`, `--agent-dir=${agentDir}`, "--trust-project"]), effective);
    const updated = await saveDecisionSettings(cwd, { ...configured, verbose: true }, { agentDir, projectTrusted: true });
    assert.equal(updated.verbose, true);
    assert.equal(updated.enabled, false);
    assert.equal(await readFile(projectFile, "utf8"), projectText);
    if (process.platform !== "win32") assert.equal((await stat(storedPath)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("untrusted malformed project preferences are ignored and trusted failures do not replace saved user preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-preferences-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectFile = join(cwd, ".pi", "decision-advisor.json");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await saveDecisionSettings(cwd, configured, { agentDir });
    const original = await readFile(join(agentDir, "decision-advisor.json"), "utf8");
    for (const malformed of ["private-marker-not-json", "[]", JSON.stringify({ reviewTools: "private-marker-unsupported" })]) {
      await writeFile(projectFile, malformed);
      assert.deepEqual(await loadDecisionSettings(cwd, { agentDir }), configured);
      await assert.rejects(loadDecisionSettings(cwd, { agentDir, projectTrusted: true }), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("private-marker"), false);
        return true;
      });
      await assert.rejects(saveDecisionSettings(cwd, { ...configured, verbose: true }, { agentDir, projectTrusted: true }));
      assert.equal(await readFile(join(agentDir, "decision-advisor.json"), "utf8"), original);
      assert.equal(await readFile(projectFile, "utf8"), malformed);
    }
    await assert.rejects(saveDecisionSettings(cwd, { ...configured, timeoutMs: 0 }, { agentDir }));
    assert.equal(await readFile(join(agentDir, "decision-advisor.json"), "utf8"), original);
    await writeFile(projectFile, "{}");
    await assert.rejects(saveDecisionSettings(cwd, configured, { agentDir: join(cwd, ".pi"), projectTrusted: true }), /read-only/);
    assert.equal(await readFile(projectFile, "utf8"), "{}");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("probe rejects unsupported flags and missing directory arguments without exposing raw stored settings", async () => {
  for (const args of [["--profile", "old"], ["--cwd"], ["--agent-dir="], ["--cwd", "--trust-project"], ["--trust-project=true"]]) {
    await assert.rejects(readStoredDecisionSettings(args));
  }
  const root = await mkdtemp(join(tmpdir(), "decision-preferences-"));
  try {
    await writeFile(join(root, "decision-advisor.json"), JSON.stringify({ reviewModel: "private-marker-invalid" }));
    await assert.rejects(readStoredDecisionSettings(["--agent-dir", root]), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private-marker"), false);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("settings dialogs cancel drafts and require confirmation before persisting elevated grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-dialog-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const selections = ["Verbose output", "Cancel"];
  const confirmations: boolean[] = [];
  const warnings: string[] = [];
  const available = [{ provider: "provider", id: "selected-reviewer" }];
  const instructions = " Keep whitespace.\n\tCheck evidence. ";
  const ctx = {
    cwd: root, mode: "rpc", hasUI: true, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => available },
    ui: {
      select: async (_title: string, options: string[]) => {
        assert.ok(options.every(option => typeof option === "string"));
        const selection = selections.shift();
        assert.ok(selection, "Unexpected dialog");
        const matched = options.find(option => option === selection || option.startsWith(`${selection} — `));
        assert.ok(matched, `Selection is unavailable: ${selection}`);
        return matched;
      },
      confirm: async () => { assert.ok(confirmations.length); return confirmations.shift()!; },
      editor: async (_title: string, prefill: string) => { assert.equal(prefill, ""); return instructions; },
      input: async (_title: string, prefill: string) => { assert.equal(prefill, String(DEFAULT_REVIEW_TIMEOUT_MS)); return "45000"; },
      notify: (message: string, type: string) => { if (type === "warning") warnings.push(message); },
    },
  } as unknown as ExtensionCommandContext;
  try {
    assert.equal(await configureDecision(ctx), undefined);
    assert.deepEqual(await readdir(root), []);
    assert.ok(warnings.length);
    selections.push("Reviewer model", "provider/selected-reviewer", "Tools", "[off] bash", "Done", "Save", "Cancel");
    confirmations.push(false, false);
    assert.equal(await configureDecision(ctx), undefined);
    assert.deepEqual(await readdir(root), []);
    selections.push("Reviewer model", "provider/selected-reviewer", "Reviewer execution timeout", "Instructions", "Tools", "[off] bash", "Done", "Save");
    confirmations.push(true, true);
    const saved = await configureDecision(ctx);
    assert.equal(saved?.reviewModel, "provider/selected-reviewer");
    assert.equal(saved?.reviewInstructions, instructions);
    assert.equal(saved?.advisorTimeoutMs, 45_000);
    assert.equal(parseReviewTools(saved!.reviewTools).includes("bash"), true);
    assert.deepEqual(await loadDecisionSettings(root, { agentDir: root }), saved);
    selections.push("Reviewer model", "Leave reviewer unconfigured", "Save");
    confirmations.push(true);
    assert.equal((await configureDecision(ctx))?.reviewModel, "");
    await mkdir(join(root, ".pi"));
    const projectFile = join(root, ".pi", "decision-advisor.json");
    const projectText = JSON.stringify({ verbose: false });
    await writeFile(projectFile, projectText);
    ctx.isProjectTrusted = () => true;
    selections.push("Verbose output", "Save");
    confirmations.push(true);
    const overridden = await configureDecision(ctx);
    assert.equal(overridden?.verbose, false);
    assert.ok(warnings.some(message => message.includes("project overrides") && message.includes("verbose")));
    assert.equal(await readFile(projectFile, "utf8"), projectText);
    assert.equal(confirmations.length, 0);
    assert.equal(selections.length, 0);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("loading modal cancellation aborts the operation and releases focus before it settles", async () => {
  type Component = { dispose(): void; onAbort?: () => void; handleInput(data: string): void };
  type Factory = (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keys: unknown, done: (value: unknown) => void) => Component;
  let component: Component | undefined;
  let focused = false;
  let operationSignal: AbortSignal | undefined;
  let resolveOperation!: (value: number) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const ctx = {
    mode: "tui",
    ui: { custom: (factory: Factory) => new Promise(resolve => {
      component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, value => {
        focused = false;
        component?.dispose();
        resolve(value);
      });
      focused = true;
    }) },
  } as unknown as ExtensionCommandContext;
  const loading = withLoading(ctx, "Loading", signal => {
    operationSignal = signal;
    markStarted();
    return new Promise<number>(resolve => { resolveOperation = resolve; });
  });
  await started;
  assert.equal(focused, true);
  component!.handleInput("\u001b");
  assert.equal(await loading, undefined);
  assert.equal(operationSignal!.aborted, true);
  assert.equal(focused, false);
  resolveOperation(42);
});

test("outer cancellation dismisses focused loading and RPC never invokes custom UI", async () => {
  const outer = new AbortController();
  let disposed = false;
  let requestSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const ctx = {
    mode: "tui",
    ui: { custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => { dispose(): void }) => new Promise(resolve => {
      const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, value => {
        component.dispose();
        disposed = true;
        resolve(value);
      });
    }) },
  } as unknown as ExtensionCommandContext;
  const loading = withLoading(ctx, "Loading", signal => {
    requestSignal = signal;
    markStarted();
    return new Promise<number>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
  }, outer.signal);
  await started;
  outer.abort();
  assert.equal(await loading, undefined);
  assert.equal(requestSignal!.aborted, true);
  assert.equal(disposed, true);
  const rpc = { mode: "rpc", ui: { custom: () => { throw new Error("Custom UI is unavailable in RPC"); } } } as unknown as ExtensionCommandContext;
  assert.equal(await withLoading(rpc, "Loading", async () => 42), 42);
  let calls = 0;
  assert.equal(await withLoading(rpc, "Loading", async () => { calls++; return 42; }, outer.signal), undefined);
  assert.equal(calls, 0);
});

test("unconfigured status is readable in print mode and structured in JSON mode without opening dialogs", async () => {
  const previousLog = console.log;
  const outputs: string[] = [];
  console.log = (value: unknown) => { outputs.push(String(value)); };
  const settings = normalizeDecisionSettings({ endpoint: "", deployment: "", reviewModel: "" });
  const context = (mode: "print" | "json") => ({ mode, ui: { select: () => { throw new Error("No dialogs in noninteractive modes"); } } }) as unknown as ExtensionCommandContext;
  try {
    await showDecisionStatus(context("print"), settings);
    assert.equal(outputs.length, 1);
    assert.match(outputs[0]!, /Scoring deployment: not configured/);
    assert.match(outputs[0]!, /Escalation reviewer: not configured/);
    await showDecisionStatus(context("json"), settings);
    const record = JSON.parse(outputs[1]!);
    assert.equal(record.type, "decision_status");
    assert.equal(record.smoke.state, "not_configured");
    assert.equal(record.reviewer, "");
    assert.equal(record.reviewerTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
    assert.equal(record.reviewHostWaitMs, REVIEW_HOST_WAIT_MS);
    assert.equal(record.scoringTimeoutMs, settings.timeoutMs);
  } finally { console.log = previousLog; }
});
