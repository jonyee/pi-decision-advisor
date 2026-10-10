import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AzureDecisionClient } from "../src/decision.ts";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import decisionAdvisor from "../src/index.ts";

// Exercise actual Pi session boundaries, tool execution and projected context. Only
// the remote model/scoring endpoints are replaced; the extension runtime is real.
test("per-tool-loop triage settles reviews without hidden primary turns and projects only live-source findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-advisor-integration-"));
  const agentDir = join(root, "agent");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const originalEvaluate = AzureDecisionClient.prototype.evaluate;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let primaryCalls = 0, reviewerCalls = 0;
  const primaryContexts: string[] = [];
  const reviewerContexts: string[] = [];
  const events: string[] = [];
  const models = ["primary", "reviewer"].map(id => ({ id, name: id, provider: "pi-integration", api: "pi-integration-api", baseUrl: "https://example.invalid", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2000 }));
  AzureDecisionClient.prototype.evaluate = async () => { throw new Error("Isolated scoring failure"); };
  function stream(model: Model<string>, context: TranscriptContext) {
    const reviewer = model.id === "reviewer";
    const text = JSON.stringify(context.messages);
    const count = reviewer ? ++reviewerCalls : ++primaryCalls;
    (reviewer ? reviewerContexts : primaryContexts).push(text);
    if (reviewer) assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name), ["read"]);
    const tool = reviewer ? !context.messages.some(message => message.role === "toolResult") : count === 1;
    const content: AssistantMessage["content"] = tool
      ? [{ type: "toolCall", id: `${model.id}-read-${count}`, name: "read", arguments: { path: join(root, "reference.txt") } }]
      : [{ type: "text", text: reviewer ? JSON.stringify({ verdict: "revise", findings: [{ severity: "concern", evidence: "reference.txt:1", explanation: "Unique verified regression finding", recommendation: "Return 42." }] }) : "99" }];
    const output: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const result = createAssistantMessageEventStream();
    queueMicrotask(() => { result.push({ type: "start", partial: output }); result.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output }); result.end(); });
    return result;
  }
  try {
    await mkdir(agentDir);
    await writeFile(join(root, "reference.txt"), "17 + 25 = 42\napi_key=fixture-private-token-123456789\n");
    await writeFile(join(agentDir, "decision-advisor.json"), JSON.stringify({ endpoint: "https://example.invalid", deployment: "fixture", credentialMode: "default", reviewModel: "pi-integration/reviewer", reviewTools: "read", timeoutMs: 1000, advisorTimeoutMs: 2000 }));
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "Compute accurately.", extensionFactories: [pi => {
      pi.registerProvider("pi-integration", { api: "pi-integration-api", apiKey: "fixture-key", baseUrl: "https://example.invalid", models, streamSimple: stream });
    }, decisionAdvisor] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: models[0], tools: ["read"], resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root) }));
    // Scoring failure must still escalate; Azure transport/batching has separate coverage.
    session.subscribe(event => { if (event.type === "entry_appended" && event.entry.type === "custom") events.push(event.entry.customType); });
    const errors: string[] = [];
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error.error) });
    await session.prompt("Read the reference and compute 17 + 25.");
    assert.deepEqual(errors, []);
    assert.equal(primaryCalls, 2);
    assert.equal(reviewerCalls, 4);
    assert.equal(session.messages.at(-1)?.role, "assistant", "feedback must not hide the primary answer in Pi print mode");
    assert.doesNotMatch(reviewerContexts.join("\n"), /fixture-private-token-123456789/);
    assert.match(reviewerContexts.join("\n"), /\[REDACTED\]/);
    assert.equal(events.filter(type => type === "decision-review").length, 2);
    assert.ok(events.indexOf("decision-error") < events.indexOf("decision-review"));
    await session.prompt("What is the corrected result?");
    assert.equal(primaryCalls, 3);
    assert.match(primaryContexts.at(-1)!, /Unique verified regression finding/);
    assert.doesNotMatch(primaryContexts.at(-1)!, /P\(pass\)/);
    const sourceIds = session.sessionManager.getBranch().flatMap(entry => {
      if (entry.type !== "custom" || entry.customType !== "decision-review") return [];
      const data: unknown = entry.data;
      assert.ok(data && typeof data === "object" && "assistantEntryId" in data && typeof data.assistantEntryId === "string");
      return [data.assistantEntryId];
    });
    for (const id of sourceIds) session.sessionManager.appendContextEdit(id, null);
    await session.prompt("Answer again without the removed turns.");
    assert.equal(primaryCalls, 4);
    assert.doesNotMatch(primaryContexts.at(-1)!, /Unique verified regression finding/);
    const reviews = session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "decision-review");
    assert.equal(reviews.length, 4);
    const beforeManual = reviewerCalls;
    await session.prompt("/decision review");
    assert.equal(reviewerCalls, beforeManual, "manual reuse must not issue a duplicate review");
    await session.prompt("/decision off");
    await session.prompt("Automatic scoring is disabled.");
    assert.equal(primaryCalls, 5);
    assert.equal(reviewerCalls, beforeManual);
    assert.equal(JSON.parse(await readFile(join(agentDir, "decision-advisor.json"), "utf8")).enabled, false);
  } finally {
    session?.dispose();
    AzureDecisionClient.prototype.evaluate = originalEvaluate;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
});
