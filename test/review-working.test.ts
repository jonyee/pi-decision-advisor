import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, InteractiveMode, initTheme, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import decisionAdvisor from "../src/index.ts";
import { AzureDecisionClient } from "../src/decision.ts";
import { Container } from "@earendil-works/pi-tui";

// Exercise the installed host's real indicator implementation, not just recorded
// extension visibility calls. Avoid a second terminal or private production APIs.
test("host Working indicator is recreated during settlement and stays removed once settled", () => {
  initTheme("dark", false);
  const host = Object.create(InteractiveMode.prototype) as any;
  const session = { isStreaming: true };
  Object.defineProperty(host, "session", { value: session });
  host.ui = { requestRender: () => {}, getClearOnShrink: () => false };
  host.options = { tuiMode: "fullscreen" };
  host.defaultEditor = { setWorkingStatusIndicator: () => {} };
  host.editor = { setWorkingStatusIndicator: () => {}, borderColor: (text: string) => text };
  host.statusContainer = new Container();
  host.defaultWorkingMessage = "Working…";
  host.workingIndicatorOptions = { frames: ["*"] };
  try {
    host.setWorkingVisible(true);
    assert.equal(host.activeStatusIndicator.kind, "working");
    assert.match(host.activeStatusIndicator.render(80).join("\n"), /Working…/);
    host.clearStatusIndicator("working"); // Native agent_end cleanup.
    assert.equal(host.activeStatusIndicator, undefined);
    host.setWorkingVisible(true); // Advisor pre-settlement wait.
    assert.equal(host.activeStatusIndicator.kind, "working");
    session.isStreaming = false; // Pi changes this before agent_settled.
    host.setWorkingVisible(false);
    host.setWorkingVisible(true);
    assert.equal(host.activeStatusIndicator, undefined);
    assert.equal(host.workingVisible, true);
    session.isStreaming = true;
    host.setWorkingVisible(true);
    assert.equal(host.activeStatusIndicator.kind, "working", "next primary run is not hidden");
  } finally {
    host.clearStatusIndicator();
  }
});

for (const mode of ["tui", "json", "rpc", "print"] as const) {
  test(`${mode}: native Working covers review settlement, not detached reviews or primary continuations`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-review-working-"));
    const agentDir = join(root, "agent");
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalEvaluate = AzureDecisionClient.prototype.evaluate;
    AzureDecisionClient.prototype.evaluate = async (_evidence, turn) => {
      if (!passing) throw new Error("Fixture scoring failure");
      return { turn, model: "fixture", evaluatedAt: new Date().toISOString(), criteria: {} as never, flagged: [] };
    };
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let reviewSource: ReturnType<typeof createAssistantMessageEventStream> | undefined;
    let finishDuringWait = false;
    let completeImmediately = false;
    let passing = false;
    let continueOnce = false;
    let primaryCalls = 0;
    const visibility: boolean[] = [];
    const statuses: Array<string | undefined> = [];
    const errors: string[] = [];
    const enteredWait = () => Promise.withResolvers<void>();
    let waiting = enteredWait();
    const models = ["primary", "reviewer"].map(id => ({ id, name: id, provider: "pi-working", api: "pi-working-api", baseUrl: "https://example.invalid", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2000 }));
    const finish = (source: ReturnType<typeof createAssistantMessageEventStream>, model: Model<string>, text: string) => {
      const output: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      source.push({ type: "done", reason: "stop", message: output });
    };
    const uiContext = {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWorkingVisible: (visible: boolean) => {
        visibility.push(visible);
        if (visible && session?.isStreaming) {
          waiting.resolve();
          if (finishDuringWait && reviewSource) finish(reviewSource, models[1]!, '{"verdict":"accept","findings":[]}');
        }
      },
      setWorkingMessage: () => assert.fail("retain the host's Working message"),
      setWorkingIndicator: () => assert.fail("retain the host's spinner settings"),
      notify: () => {},
    } as unknown as ExtensionUIContext;
    const tick = () => new Promise<void>(resolve => setImmediate(resolve));
    const assertVisibility = (expected: boolean[]) => assert.deepEqual(visibility, mode === "tui" ? expected : []);
    try {
      await mkdir(agentDir);
      await writeFile(join(agentDir, "decision-advisor.json"), JSON.stringify({ endpoint: "https://example.invalid", deployment: "fixture", reviewModel: "pi-working/reviewer", reviewTools: "", advisorTimeoutMs: 2000 }));
      const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "Answer accurately.", extensionFactories: [pi => {
        pi.registerProvider("pi-working", { api: "pi-working-api", apiKey: "fixture-key", baseUrl: "https://example.invalid", models, streamSimple: (model) => {
          const source = createAssistantMessageEventStream();
          if (model.id === "reviewer") {
            reviewSource = source;
            if (completeImmediately) queueMicrotask(() => finish(source, model, '{"verdict":"accept","findings":[]}'));
          } else {
            primaryCalls++;
            queueMicrotask(() => finish(source, model, "42"));
          }
          return source;
        } });
      }, pi => decisionAdvisor(pi, { reviewWaitMs: 30 }), pi => {
        // Runs after the advisor's bounded hook; verifies continuation cleanup.
        pi.on("agent_before_settle", () => {
          if (!continueOnce) return;
          continueOnce = false;
          passing = true;
          pi.sendUserMessage("Continue this fixture with a final response.", { deliverAs: "followUp" });
          return { continue: true };
        });
        pi.on("agent_settled", () => {
          if (mode === "tui") assert.equal(visibility.at(-1), true, "native visibility restored for subsequent runs");
        });
      }] });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({ cwd: root, agentDir, model: models[0], tools: [], resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root) }));
      await session.bindExtensions({ mode, uiContext, onError: error => errors.push(error.error) });
      finishDuringWait = true;
      if (mode !== "tui") completeImmediately = true;
      await session.prompt("Complete the review before settlement.");
      assertVisibility([true, false, true]);
      if (mode === "tui") assert.equal(statuses.at(-1), undefined);

      visibility.length = 0;
      finishDuringWait = false;
      completeImmediately = false;
      await session.prompt("Let this review outlive the settlement wait.");
      assertVisibility([true, false, true]);
      assert.equal(session.isStreaming, false);
      if (mode === "tui") assert.equal(statuses.at(-1), "Reviewing…");
      finish(reviewSource!, models[1]!, '{"verdict":"accept","findings":[]}');
      await tick();
      assertVisibility([true, false, true]); // Late completion must not touch the native loader.
      if (mode === "tui") assert.equal(statuses.at(-1), undefined);

      visibility.length = 0;
      continueOnce = true;
      const before = primaryCalls;
      await session.prompt("Continue the primary after the bounded review wait.");
      assert.equal(primaryCalls, before + 2);
      // Continuation relinquishes without hiding, then the still-pending earlier
      // review gets a fresh wait after the continuation's own agent_end.
      assertVisibility([true, true, true, false, true]);
      finish(reviewSource!, models[1]!, '{"verdict":"accept","findings":[]}');
      await tick();
      assertVisibility([true, true, true, false, true]);

      visibility.length = 0;
      waiting = enteredWait();
      passing = false;
      if (mode === "tui") {
        const run = session.prompt("Cancel extension work while the spinner is showing.");
        await waiting.promise;
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
        await run;
        assertVisibility([true, false, true]);
        assert.equal(statuses.at(-1), undefined);
      }
      assert.deepEqual(errors, []);
      if (mode !== "tui") assert.deepEqual(statuses, []);
    } finally {
      session?.dispose();
      AzureDecisionClient.prototype.evaluate = originalEvaluate;
      reviewSource?.end();
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
