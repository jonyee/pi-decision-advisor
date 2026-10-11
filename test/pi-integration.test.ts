import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AzureDecisionClient, MAX_EVIDENCE_TOKENS } from "../src/decision.ts";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import decisionAdvisor from "../src/index.ts";
import { countEvidenceTokens } from "../src/evidence-tokens.ts";
import type { TurnEvidence } from "../src/types.ts";

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

test("bounded hook wait preserves late findings while session reset and user cancellation stop reviewers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-advisor-lifecycle-"));
  const agentDir = join(root, "agent");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const originalEvaluate = AzureDecisionClient.prototype.evaluate;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const primaryContexts: string[] = [];
  const reviews: Array<{ source: ReturnType<typeof createAssistantMessageEventStream>; signal?: AbortSignal; model: Model<string> }> = [];
  let primaryGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let heldPrimary: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  const appended: string[] = [];
  const persisted = Promise.withResolvers<void>();
  const models = ["primary", "reviewer"].map(id => ({ id, name: id, provider: "pi-lifecycle", api: "pi-lifecycle-api", baseUrl: "https://example.invalid", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2000 }));
  AzureDecisionClient.prototype.evaluate = async () => { throw new Error("Isolated scoring failure"); };
  function output(model: Model<string>, text: string): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  function finish(source: ReturnType<typeof createAssistantMessageEventStream>, message: AssistantMessage) {
    source.push({ type: "done", reason: "stop", message });
  }
  try {
    await mkdir(agentDir);
    await writeFile(join(agentDir, "decision-advisor.json"), JSON.stringify({ reviewModel: "pi-lifecycle/reviewer", reviewTools: "", advisorTimeoutMs: 60_000 }));
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "Compute accurately.", extensionFactories: [pi => {
      pi.registerProvider("pi-lifecycle", { api: "pi-lifecycle-api", apiKey: "fixture-key", baseUrl: "https://example.invalid", models,
        streamSimple: (model, context, options) => {
          const source = createAssistantMessageEventStream();
          if (model.id === "reviewer") reviews.push({ source, signal: options?.signal, model });
          else {
            primaryContexts.push(JSON.stringify(context.messages));
            if (primaryGate) { heldPrimary = source; primaryGate.resolve(); }
            else queueMicrotask(() => finish(source, output(model, "42")));
          }
          return source;
        },
      });
    }, pi => decisionAdvisor(pi, { reviewWaitMs: 0 })] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: models[0], tools: [], resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root) }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error.error) });
    session.subscribe(event => {
      if (event.type !== "entry_appended" || event.entry.type !== "custom") return;
      appended.push(event.entry.customType);
      if (event.entry.customType === "decision-review") persisted.resolve();
    });
    await session.prompt("Compute 17 + 25.");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.signal?.aborted, false, "hook wait must not cancel execution");
    assert.equal(appended.includes("decision-review"), false);
    const finding = { severity: "concern", evidence: "17 + 25 = 42", explanation: "Persisted late arithmetic finding", recommendation: "Return 42." };
    finish(reviews[0]!.source, output(reviews[0]!.model, JSON.stringify({ verdict: "revise", findings: [finding] })));
    await persisted.promise;
    await session.prompt("Use the verified result.");
    assert.equal(primaryContexts.length, 2, "late findings must not create a hidden primary request");
    assert.match(primaryContexts[1]!, /Persisted late arithmetic finding/);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1]!.signal?.aborted, false);
    const firstUser = session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
    assert.ok(firstUser);
    const reviewCount = appended.filter(type => type === "decision-review").length;
    assert.equal((await session.navigateTree(firstUser.id, { summarize: false })).cancelled, false);
    assert.equal(reviews[1]!.signal?.aborted, true, "session tree reset must cancel execution");
    finish(reviews[1]!.source, output(reviews[1]!.model, JSON.stringify({ verdict: "revise", findings: [finding] })));
    const tick = Promise.withResolvers<void>();
    setImmediate(tick.resolve);
    await tick.promise;
    assert.equal(appended.filter(type => type === "decision-review").length, reviewCount);
    await session.prompt("Start another review.");
    assert.equal(reviews.length, 3);
    primaryGate = Promise.withResolvers<void>();
    const primaryRun = session.prompt("Cancel this active primary run.");
    await primaryGate.promise;
    assert.equal(reviews[2]!.signal?.aborted, false);
    const aborted = session.abort();
    assert.equal(reviews[2]!.signal?.aborted, true, "real user cancellation during an active primary run cancels pending reviewers");
    heldPrimary!.push({ type: "error", reason: "aborted", error: { ...output(models[0]!, ""), stopReason: "aborted", errorMessage: "Fixture cancellation" } });
    await Promise.all([primaryRun, aborted]);
    finish(reviews[2]!.source, output(reviews[2]!.model, JSON.stringify({ verdict: "revise", findings: [finding] })));
    primaryGate = undefined;
    await session.prompt("Review before disabling automatic review.");
    assert.equal(reviews.length, 4);
    assert.equal(reviews[3]!.signal?.aborted, false);
    await session.prompt("/decision off");
    assert.equal(reviews[3]!.signal?.aborted, true, "enabled-off must cancel in-flight execution");
    finish(reviews[3]!.source, output(reviews[3]!.model, JSON.stringify({ verdict: "revise", findings: [finding] })));
    const afterOff = Promise.withResolvers<void>();
    setImmediate(afterOff.resolve);
    await afterOff.promise;
    assert.equal(appended.filter(type => type === "decision-review").length, reviewCount);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    AzureDecisionClient.prototype.evaluate = originalEvaluate;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi captures bounded redacted evidence and retains current-only overflow for the reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-advisor-packing-"));
  const agentDir = join(root, "agent");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const originalEvaluate = AzureDecisionClient.prototype.evaluate;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const current = "7".repeat(MAX_EVIDENCE_TOKENS);
  const previous = "7".repeat(MAX_EVIDENCE_TOKENS + 1);
  const scored: TurnEvidence[] = [];
  const reviewed: TurnEvidence[] = [];
  const failures: Array<{ reason?: string; detail?: string }> = [];
  const models = ["primary", "reviewer"].map(id => ({ id, name: id, provider: "pi-packing", api: "pi-packing-api", baseUrl: "https://example.invalid", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 2000 }));
  AzureDecisionClient.prototype.evaluate = async evidence => { scored.push(evidence); throw new Error("Isolated scoring failure"); };
  try {
    await mkdir(agentDir);
    await writeFile(join(agentDir, "decision-advisor.json"), JSON.stringify({ endpoint: "https://example.invalid", deployment: "fixture", reviewModel: "pi-packing/reviewer", reviewTools: "", advisorTimeoutMs: 2000 }));
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "Compute accurately.", extensionFactories: [pi => {
      pi.registerProvider("pi-packing", { api: "pi-packing-api", apiKey: "fixture-key", baseUrl: "https://example.invalid", models,
        streamSimple: (model, context) => {
          if (model.id === "reviewer") {
            const request = context.messages.find(message => message.role === "user");
            assert.ok(request && request.role === "user");
            const text = typeof request.content === "string" ? request.content : request.content.filter(block => block.type === "text").map(block => block.text).join("\n");
            const payload: unknown = JSON.parse(text);
            assert.ok(payload && typeof payload === "object" && "evidence" in payload);
            const evidence = payload.evidence;
            assert.ok(evidence && typeof evidence === "object" && "instructions" in evidence && Array.isArray(evidence.instructions));
            assert.ok(evidence.instructions.every((instruction: unknown) => typeof instruction === "string"));
            assert.ok("userRequest" in evidence && typeof evidence.userRequest === "string");
            assert.ok("recentHistory" in evidence && Array.isArray(evidence.recentHistory));
            assert.ok("assistant" in evidence && "toolResults" in evidence && Array.isArray(evidence.toolResults));
            reviewed.push({ instructions: evidence.instructions, userRequest: evidence.userRequest, recentHistory: evidence.recentHistory, assistant: evidence.assistant, toolResults: evidence.toolResults });
          }
          const output: AssistantMessage = { role: "assistant", content: [{ type: "text", text: model.id === "reviewer" ? '{"verdict":"accept","findings":[]}' : "42" }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const source = createAssistantMessageEventStream();
          queueMicrotask(() => source.push({ type: "done", reason: "stop", message: output }));
          return source;
        },
      });
    }, decisionAdvisor] });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(root);
    manager.appendMessage({ role: "user", content: previous, timestamp: Date.now() });
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: models[0], tools: [], resourceLoader, settingsManager, sessionManager: manager }));
    await session.bindExtensions({ mode: "json", onError: error => { throw new Error(error.error); } });
    session.subscribe(event => {
      if (event.type !== "entry_appended" || event.entry.type !== "custom" || event.entry.customType !== "decision-error") return;
      const data: unknown = event.entry.data;
      assert.ok(data && typeof data === "object" && "reason" in data && typeof data.reason === "string");
      assert.ok(!("detail" in data) || data.detail === undefined || typeof data.detail === "string");
      failures.push({ reason: data.reason, detail: "detail" in data && typeof data.detail === "string" ? data.detail : undefined });
    });
    await session.prompt('Current safe request. api_key="fixture-redaction-secret-123456"');
    assert.equal(scored.length, 1);
    assert.ok(countEvidenceTokens(JSON.stringify(scored[0])) <= MAX_EVIDENCE_TOKENS);
    assert.deepEqual(reviewed[0], scored[0]);
    assert.doesNotMatch(JSON.stringify(reviewed[0]), /fixture-redaction-secret-123456/);
    assert.match(JSON.stringify(reviewed[0]), /REDACTED/);
    assert.equal(JSON.stringify(reviewed[0]).includes(previous), false);
    await session.prompt(current);
    assert.equal(scored.length, 1, "overflow must be classified before scoring or credentials");
    assert.equal(failures.at(-1)?.reason, "evidence_current_overflow");
    assert.ok(failures.at(-1)?.detail);
    assert.equal(failures.at(-1)?.detail?.includes(current), false);
    assert.deepEqual(JSON.parse(reviewed[1]!.userRequest), [{ type: "text", text: current }]);
    assert.ok(countEvidenceTokens(JSON.stringify(reviewed[1])) > MAX_EVIDENCE_TOKENS);
  } finally {
    session?.dispose();
    AzureDecisionClient.prototype.evaluate = originalEvaluate;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
});


test("Pi records distinct review failures and explicit manual retries reuse captured evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-advisor-categories-"));
  const agentDir = join(root, "agent");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let failure: "timeout" | "provider" | "response" | "accept" = "timeout";
  let reviewerCalls = 0;
  const pendingSources: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  const categories: string[] = [];
  const models = ["primary", "reviewer"].map(id => ({ id, name: id, provider: "pi-categories", api: "pi-categories-api", baseUrl: "https://example.invalid", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2000 }));
  try {
    await mkdir(agentDir);
    await writeFile(join(agentDir, "decision-advisor.json"), JSON.stringify({ reviewModel: "pi-categories/reviewer", reviewTools: "", advisorTimeoutMs: 100 }));
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "Compute accurately.", extensionFactories: [pi => {
      pi.registerProvider("pi-categories", { api: "pi-categories-api", apiKey: "fixture-key", baseUrl: "https://example.invalid", models,
        streamSimple: (model) => {
          const source = createAssistantMessageEventStream();
          if (model.id === "reviewer") {
            reviewerCalls++;
            if (failure === "provider") throw new Error("private-provider-body api_key=fixture-private-credential");
            if (failure === "timeout") { pendingSources.push(source); return source; }
          }
          const text = model.id === "primary" ? "42" : failure === "response" ? "invalid private review" : '{"verdict":"accept","findings":[]}';
          const output: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          queueMicrotask(() => source.push({ type: "done", reason: "stop", message: output }));
          return source;
        },
      });
    }, decisionAdvisor] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: models[0], tools: [], resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root) }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error.error) });
    session.subscribe(event => {
      if (event.type !== "entry_appended" || event.entry.type !== "custom" || event.entry.customType !== "decision-review-error") return;
      const data: unknown = event.entry.data;
      assert.ok(data && typeof data === "object" && "category" in data && typeof data.category === "string");
      categories.push(data.category);
      assert.doesNotMatch(JSON.stringify(data), /private-provider-body|fixture-private-credential|invalid private review/);
    });
    await session.prompt("Compute 17 + 25.");
    assert.deepEqual(categories, ["timeout"]);
    failure = "provider";
    await session.prompt("/decision review");
    assert.deepEqual(categories, ["timeout", "provider"]);
    failure = "response";
    await session.prompt("/decision review");
    assert.deepEqual(categories, ["timeout", "provider", "response"]);
    failure = "accept";
    await session.prompt("/decision review");
    assert.equal(reviewerCalls, 4);
    assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "decision-review").length, 1);
    await session.prompt("/decision review");
    assert.equal(reviewerCalls, 4, "completed manual reuse must not call the provider again");
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    for (const source of pendingSources) source.end();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
});
