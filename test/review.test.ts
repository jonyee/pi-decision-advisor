import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/review-result.ts";
import { buildEvidence } from "../src/evidence.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type CredentialStore, type ToolCall } from "@earendil-works/pi-ai";
import { createReviewTools } from "../src/review-tools.ts";
import { ReviewerConfigurationError, ReviewerError, reviewTurn, waitForReviews } from "../src/review.ts";
import { createSecretRedactor, SecretRedactor } from "../src/secrets.ts";
import type { TurnEvidence } from "../src/types.ts";

test("review verdict cannot accept concrete defect findings", () => {
  const finding = { severity: "blocker", evidence: "result = 5", explanation: "2 + 2 is not 5", recommendation: "Return 4" };
  assert.throws(() => parseReview(JSON.stringify({ verdict: "accept", findings: [finding] }), "reviewer"), /contradicts/);
  assert.deepEqual(parseReview(JSON.stringify({ verdict: "revise", findings: [finding] }), "reviewer").findings, [finding]);
  assert.throws(() => parseReview('{"verdict":"revise","findings":[]}', "reviewer"), /contradicts/);
});

test("findings without evidence cannot steer the primary", () => {
  assert.throws(() => parseReview('{"verdict":"revise","findings":[{"severity":"concern","explanation":"bad","recommendation":"fix"}]}', "reviewer"), /lacks/);
  assert.throws(() => parseReview("Some prose, not a review", "reviewer"), /valid JSON/);
  assert.equal(parseReview('```json\n{"verdict":"cannot_tell","findings":[]}\n```', "reviewer").verdict, "cannot_tell");
});

test("turn evidence keeps latest request, not advisor self-feedback or replay attachments", () => {
  const history = [
    { role: "user", content: "First goal" },
    { role: "user", content: [{ type: "text", text: "Current goal" }, { type: "image", data: "binary", mimeType: "image/png" }] },
    { role: "custom", customType: "decision-feedback", content: "False blocker" },
  ];
  const evidence = buildEvidence(["rules"], history, { role: "assistant", providerPayload: { items: ["opaque-envelope"] }, responseId: "opaque-id", content: [{ type: "thinking", thinking: "inspect", thinkingSignature: "secret-signature" }] }, []);
  const serialized = JSON.stringify(evidence);
  assert.match(evidence.userRequest, /Current goal/);
  assert.match(serialized, /unavailable_attachment/);
  assert.doesNotMatch(serialized, /binary|secret-signature|False blocker|opaque-envelope|opaque-id/);
});

const reviewerEvidence: TurnEvidence = { instructions: ["Inspect the current workspace."], userRequest: "Check answer.txt", recentHistory: [], assistant: "Done", toolResults: [] };
const reviewerOptions = { model: "local-review/checker", timeoutMs: 2_000, tools: "read,grep,find", instructions: "", history: [] };
const accepted = '{"verdict":"accept","findings":[]}';
const providerKey = "local-provider-key-9y8x7w6v";
const providerHeader = "local-header-secret-4p5q6r7s";

interface CompletionRequest {
  messages: Array<{ role: string; content?: string | unknown[]; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
}

function completion(response: ServerResponse, output: string | { name: string; args: ToolCall["arguments"] }): void {
  const tool = typeof output !== "string";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "operation-1", type: "function", function: { name: output.name, arguments: JSON.stringify(output.args) } }] } : { role: "assistant", content: output };
  response.write(`data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", model: "checker", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", model: "checker", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function isolatedWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-"));
  try { await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

function context(cwd: string, modelRegistry: ModelRegistry, confirm: ExtensionContext["ui"]["confirm"] = async () => false, mode: ExtensionContext["mode"] = "tui"): ExtensionContext {
  // The bare Agent must not consult any primary-session or ambient prompt resources.
  return {
    cwd, modelRegistry, model: modelRegistry.find("local-review", "checker"), mode,
    hasUI: mode === "tui" || mode === "rpc", ui: { confirm },
    getSystemPrompt: () => { throw new Error("Ambient system prompt accessed"); },
    sessionManager: { getBranch: () => { throw new Error("Ambient session accessed"); } },
  } as unknown as ExtensionContext;
}

async function localReviewer(cwd: string, respond: (request: CompletionRequest, response: ServerResponse, raw: IncomingMessage) => void | Promise<void>, run: (ctx: ExtensionContext) => Promise<void>): Promise<void> {
  let serverFailure: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
      assert.equal(request.headers["x-review-secret"], providerHeader);
      const body: CompletionRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(Array.isArray(body.messages));
      await respond(body, response, request);
    })().catch(error => { serverFailure = error; response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const credentials: CredentialStore = {
    read: async () => undefined, list: async () => [], modify: async (_provider, update) => update(undefined), delete: async () => {},
  };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider("local-review", {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: providerKey,
    headers: { "x-review-secret": providerHeader },
    models: [{ id: "checker", name: "checker", input: ["text"], reasoning: false, contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  try { await run(context(cwd, registry)); if (serverFailure) throw serverFailure; }
  catch (error) { throw serverFailure ?? error; }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("read-only reviewer reads actual files in an isolated transcript with configured provider auth", async () => {
  await isolatedWorkspace(async cwd => {
    await writeFile(join(cwd, "answer.txt"), "The independently inspected answer is 4.\n");
    let calls = 0;
    await localReviewer(cwd, (request, response) => {
      calls++;
      if (calls === 1) completion(response, { name: "read", args: { path: "answer.txt" } });
      else {
        assert.match(JSON.stringify(request.messages.filter(message => message.role === "tool")), /independently inspected answer is 4/);
        completion(response, accepted);
      }
    }, async ctx => {
      assert.equal((await reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, tools: "read" }, new SecretRedactor())).verdict, "accept");
    });
    assert.equal(calls, 2);
  });
});

test("empty grants expose no tools and invalid model or persisted OMP grants fail before inference", async () => {
  await isolatedWorkspace(async cwd => {
    let calls = 0;
    await localReviewer(cwd, (request, response) => {
      calls++;
      assert.equal(request.tools?.length ?? 0, 0);
      completion(response, accepted);
    }, async ctx => {
      const signal = new AbortController().signal;
      const redactor = new SecretRedactor();
      for (const model of ["", "@advisor", "checker", "local-review/missing"]) {
        await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, signal, { ...reviewerOptions, model, tools: "" }, redactor), error => error instanceof ReviewerConfigurationError && error.code === "configuration");
      }
      for (const tools of ["glob", "recall", "lsp", "web_search", "eval", "ast_edit", "debug"]) {
        await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, signal, { ...reviewerOptions, tools }, redactor), ReviewerConfigurationError);
      }
      for (const timeoutMs of [99, 120_001, NaN, Infinity, 100.5]) {
        await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, signal, { ...reviewerOptions, timeoutMs, tools: "" }, redactor), error => error instanceof ReviewerConfigurationError && error.code === "configuration");
      }
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, cancelled.signal, { ...reviewerOptions, tools: "" }, redactor), error => error instanceof ReviewerError && error.code === "cancelled");
      assert.equal(calls, 0);
      assert.equal((await reviewTurn(ctx, reviewerEvidence, undefined, signal, { ...reviewerOptions, tools: "" }, redactor)).verdict, "accept");
    });
    assert.equal(calls, 1);
  });
});

test("missing stock tool prerequisites fail explicitly before inference without downloading", async () => {
  await isolatedWorkspace(async cwd => {
    const oldPath = process.env.PATH;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = "";
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      let calls = 0;
      await localReviewer(cwd, (_request, response) => { calls++; completion(response, accepted); }, async ctx => {
        await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, tools: "grep" }, new SecretRedactor()), error => {
          assert.ok(error instanceof ReviewerConfigurationError);
          assert.match(error.message, /install rg first/);
          return true;
        });
        assert.equal(calls, 0);
      });
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
  });
});

test("every elevated write requires actual approval; denial and headless never mutate", async () => {
  await isolatedWorkspace(async cwd => {
    let confirmations = 0;
    await localReviewer(cwd, (_request, response) => completion(response, accepted), async base => {
      const ctx = context(cwd, base.modelRegistry, async () => { confirmations++; return true; }, "rpc");
      const [write] = createReviewTools(ctx, ["write"], new AbortController().signal, new SecretRedactor());
      await write.execute("write-1", { path: "approved.txt", content: "first" });
      await write.execute("write-2", { path: "approved.txt", content: "second" });
      assert.equal(confirmations, 2);
      assert.equal(await readFile(join(cwd, "approved.txt"), "utf8"), "second");
      for (const mode of ["tui", "print", "json"] as const) {
        const denied = context(cwd, base.modelRegistry, async () => { confirmations++; return false; }, mode);
        const [tool] = createReviewTools(denied, ["write"], new AbortController().signal, new SecretRedactor());
        await assert.rejects(tool.execute("denied", { path: `${mode}.txt`, content: "must not exist" }), /not approved|headless/);
        await assert.rejects(readFile(join(cwd, `${mode}.txt`)), { code: "ENOENT" });
      }
      assert.equal(confirmations, 3);
    });
  });
});

test("denied reviewer tools cannot be converted to accept by a subsequent provider answer", async () => {
  await isolatedWorkspace(async cwd => {
    let calls = 0;
    await localReviewer(cwd, (_request, response) => {
      completion(response, ++calls === 1 ? { name: "write", args: { path: "denied.txt", content: "bad" } } : accepted);
    }, async ctx => {
      await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, tools: "write" }, new SecretRedactor()), error => error instanceof ReviewerError && error.code === "tool");
      await assert.rejects(readFile(join(cwd, "denied.txt")), { code: "ENOENT" });
    });
    assert.equal(calls, 2);
  });
});

test("late UI approval after cancellation cannot execute an elevated mutation", async () => {
  await isolatedWorkspace(async cwd => {
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    await localReviewer(cwd, (_request, response) => completion(response, { name: "write", args: { path: "late.txt", content: "must not exist" } }), async base => {
      const ctx = context(cwd, base.modelRegistry, async (_title, _message, options) => {
        assert.ok(options?.signal);
        entered();
        return new Promise<boolean>(resolve => { approve = resolve; });
      });
      const pending = reviewTurn(ctx, reviewerEvidence, undefined, controller.signal, { ...reviewerOptions, tools: "write" }, new SecretRedactor());
      const rejection = assert.rejects(pending, /cancelled/);
      await waiting;
      controller.abort();
      await rejection;
      approve(true);
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(readFile(join(cwd, "late.txt")), { code: "ENOENT" });
    });
  });
});

test("timeout settles an unresolved dialog and rejects approval that arrives after the deadline", async () => {
  await isolatedWorkspace(async cwd => {
    let approve!: (value: boolean) => void;
    await localReviewer(cwd, (_request, response) => completion(response, { name: "write", args: { path: "timeout.txt", content: "bad" } }), async base => {
      const ctx = context(cwd, base.modelRegistry, () => new Promise<boolean>(resolve => { approve = resolve; }));
      await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, timeoutMs: 100, tools: "write" }, new SecretRedactor()), error => error instanceof ReviewerError && error.code === "timeout");
      assert.equal(typeof approve, "function");
      approve(true);
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(readFile(join(cwd, "timeout.txt")), { code: "ENOENT" });
    });
  });
});

test("cancelled model streams cannot deliver a late tool call", async () => {
  await isolatedWorkspace(async cwd => {
    const controller = new AbortController();
    let entered!: () => void;
    let reply!: () => void;
    let confirmations = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    await localReviewer(cwd, (_request, response) => {
      reply = () => completion(response, { name: "write", args: { path: "model-late.txt", content: "bad" } });
      entered();
    }, async base => {
      const ctx = context(cwd, base.modelRegistry, async () => { confirmations++; return true; });
      const pending = reviewTurn(ctx, reviewerEvidence, undefined, controller.signal, { ...reviewerOptions, tools: "write" }, new SecretRedactor());
      const rejection = assert.rejects(pending, /cancelled/);
      await waiting;
      controller.abort();
      await rejection;
      reply();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(confirmations, 0);
      await assert.rejects(readFile(join(cwd, "model-late.txt")), { code: "ENOENT" });
    });
  });
});

test("provider and invalid-response failures have sanitized typed categories", async () => {
  await isolatedWorkspace(async cwd => {
    for (const status of [401, 403, 429, 503]) {
      await localReviewer(cwd, (_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `private-provider-body ${providerKey}`, type: "provider_failure" } }));
      }, async ctx => {
        await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, tools: "" }, new SecretRedactor([providerKey])), error => {
          assert.ok(error instanceof ReviewerError);
          // Streamed provider prose does not expose a trustworthy HTTP status; never guess authentication.
          assert.equal(error.code, "provider");
          assert.doesNotMatch(error.message, /private-provider-body|local-provider-key/);
          return true;
        });
      });
    }
    for (const text of ["not JSON", '{"verdict":"accept","findings":[{"severity":"concern"}]}', '{"verdict":"revise","findings":[]}']) {
      await localReviewer(cwd, (_request, response) => completion(response, text), async ctx => {
        await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, tools: "" }, new SecretRedactor()), error => error instanceof ReviewerError && error.code === "response");
      });
    }
  });
});

test("execution deadline settles a provider that ignores abort and never resolves result", async () => {
  await isolatedWorkspace(async cwd => {
    await localReviewer(cwd, () => { throw new Error("HTTP should not be reached"); }, async ctx => {
      const source = createAssistantMessageEventStream();
      let providerSignal: AbortSignal | undefined;
      ctx.modelRegistry.registerProvider("local-review", {
        api: "openai-completions", apiKey: providerKey, baseUrl: "https://example.invalid",
        models: [{ id: "checker", name: "checker", input: ["text"], reasoning: false, contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (_model, _context, options) => { providerSignal = options?.signal; return source; },
      });
      await assert.rejects(reviewTurn(ctx, reviewerEvidence, undefined, new AbortController().signal, { ...reviewerOptions, timeoutMs: 100, tools: "" }, new SecretRedactor()), error => error instanceof ReviewerError && error.code === "timeout");
      assert.equal(providerSignal?.aborted, true);
      // The provider still owns its unresolved stream; the reviewer has already settled independently.
      source.end();
    });
  });
});

test("host wait expires without cancelling reviewer; explicit cancellation rejects late provider tools", async () => {
  await isolatedWorkspace(async cwd => {
    await localReviewer(cwd, () => { throw new Error("HTTP should not be reached"); }, async ctx => {
      const sources: ReturnType<typeof createAssistantMessageEventStream>[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      let { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
      ctx.modelRegistry.registerProvider("local-review", {
        api: "openai-completions", apiKey: providerKey, baseUrl: "https://example.invalid",
        models: [{ id: "checker", name: "checker", input: ["text"], reasoning: false, contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (_model, _context, options) => {
          const source = createAssistantMessageEventStream();
          sources.push(source); signals.push(options?.signal); entered(); return source;
        },
      });
      const generation = new AbortController();
      let verdict: string | undefined;
      const pending = reviewTurn(ctx, reviewerEvidence, undefined, generation.signal, { ...reviewerOptions, tools: "" }, new SecretRedactor()).then(result => { verdict = result.verdict; });
      await waiting;
      await waitForReviews([pending], generation.signal, 0);
      assert.equal(verdict, undefined);
      assert.equal(signals[0]?.aborted, false);
      const model = ctx.modelRegistry.find("local-review", "checker")!;
      const output: AssistantMessage = { role: "assistant", content: [{ type: "text", text: accepted }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      sources[0]!.push({ type: "done", reason: "stop", message: output });
      await pending;
      assert.equal(verdict, "accept");
      ({ promise: waiting, resolve: entered } = Promise.withResolvers<void>());
      const cancelled = reviewTurn(ctx, reviewerEvidence, undefined, generation.signal, { ...reviewerOptions, tools: "write" }, new SecretRedactor());
      const rejection = assert.rejects(cancelled, error => error instanceof ReviewerError && error.code === "cancelled");
      await waiting;
      generation.abort();
      await rejection;
      assert.equal(signals[1]?.aborted, true);
      sources[1]!.push({ type: "done", reason: "toolUse", message: { ...output, stopReason: "toolUse", content: [{ type: "toolCall", id: "late-write", name: "write", arguments: { path: "after-cancel.txt", content: "bad" } }] } });
      const tick = Promise.withResolvers<void>();
      setImmediate(tick.resolve);
      await tick.promise;
      await assert.rejects(readFile(join(cwd, "after-cancel.txt")), { code: "ENOENT" });
    });
  });
});

test("credential redaction covers environment values, vendor tokens, auth headers and nested structured results without destroying benign text", () => {
  const redactor = new SecretRedactor(["long-opaque-credential-38u29j", "yes", "password"]);
  const original = {
    content: [{ type: "text", text: 'API_KEY="fresh opaque secret"\nAuthorization: Bearer a-short-key\npostgres://user:db-password@host/db\n?sig=sas-signature&ok=1\nlong-opaque-credential-38u29j\nghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
    details: { authorization: "Basic Zm9vOmJhcg==", nested: { refreshToken: "refresh-value", patch: '- password = "old-password"\n+ password = "new-password"' } },
    structuredContent: { apiKey: "unknown-key", nested: '{"client_secret":"embedded-secret"}' },
  };
  const result = redactor.redactObject(original);
  assert.doesNotMatch(JSON.stringify(result), /fresh opaque secret|a-short-key|db-password|sas-signature|long-opaque|ghp_|Zm9v|refresh-value|old-password|new-password|unknown-key|embedded-secret/);
  assert.match(JSON.stringify(result), /REDACTED/);
  assert.match(original.content[0].text, /fresh opaque secret/);
  assert.equal(redactor.redactText("yes password token_expiry_seconds = 30; key_count = 2; monkey = true"), "yes password token_expiry_seconds = 30; key_count = 2; monkey = true");
  const escaped = JSON.stringify({ text: JSON.stringify({ api_key: "escaped-secret" }) });
  assert.doesNotMatch(redactor.redactText(escaped), /escaped-secret/);
  const preferences = 'Reviewer preferences supplied by the user:\npassword="initial-private-credential"';
  assert.doesNotMatch(redactor.redactText(preferences), /initial-private-credential/);
  const serializedFinding = JSON.stringify({ evidence: 'api_key = "fresh-file-secret"' });
  assert.doesNotMatch(redactor.redactText(serializedFinding), /fresh-file-secret/);
  assert.deepEqual(JSON.parse(redactor.redactText(serializedFinding)), { evidence: 'api_key = "[REDACTED]"' });
  assert.deepEqual(JSON.parse(redactor.redactText(redactor.redactText(serializedFinding))), { evidence: 'api_key = "[REDACTED]"' });
  const nestedPreferences = JSON.stringify({ text: redactor.redactText(preferences) });
  assert.doesNotMatch(redactor.redactText(nestedPreferences), /initial-private-credential/);
});

test("fresh file reads, edit diffs, shell structured output and findings are redacted before retention", async () => {
  await isolatedWorkspace(async cwd => {
    const opaque = "fresh-file-secret-7d8f9g0h";
    await writeFile(join(cwd, "answer.txt"), `api_key = "${opaque}"\nAnswer is 4\n`);
    let calls = 0;
    await localReviewer(cwd, (request, response) => {
      calls++;
      if (calls === 1) {
        assert.doesNotMatch(JSON.stringify(request.messages), /initial-private-credential/);
        completion(response, { name: "read", args: { path: "answer.txt" } });
      } else {
        assert.doesNotMatch(JSON.stringify(request.messages), new RegExp(opaque));
        assert.match(JSON.stringify(request.messages), /REDACTED/);
        completion(response, JSON.stringify({ verdict: "revise", findings: [{ severity: "concern", evidence: `api_key = "${opaque}"`, explanation: "Bearer private-finding-token", recommendation: `Remove ${providerKey}` }] }));
      }
    }, async base => {
      const redactor = await createSecretRedactor(base);
      const result = await reviewTurn(base, { ...reviewerEvidence, userRequest: 'token="initial-private-credential"' }, undefined, new AbortController().signal, { ...reviewerOptions, tools: "read", instructions: 'password="initial-private-credential"' }, redactor);
      assert.doesNotMatch(JSON.stringify(result), /fresh-file-secret|private-finding-token|local-provider-key/);
      const ctx = context(cwd, base.modelRegistry, async () => true);
      const tools = createReviewTools(ctx, ["edit", "bash"], new AbortController().signal, redactor);
      const edit = tools.find(tool => tool.name === "edit")!;
      const edited = await edit.execute("edit", { path: "answer.txt", edits: [{ oldText: "Answer is 4", newText: 'Answer is 4\npassword="new-diff-secret"' }] });
      assert.doesNotMatch(JSON.stringify(edited), /fresh-file-secret|new-diff-secret/);
      const bash = tools.find(tool => tool.name === "bash")!;
      const output = await bash.execute("bash", { command: "printf 'api_key=structured-shell-secret\\n'" });
      assert.ok(output.structuredContent);
      assert.doesNotMatch(JSON.stringify(output), /structured-shell-secret/);
    });
  });
});

test("already cancelled filesystem work cannot start confirmation or commit a write", async () => {
  await isolatedWorkspace(async cwd => {
    await localReviewer(cwd, (_request, response) => completion(response, accepted), async base => {
      const controller = new AbortController();
      let confirmations = 0;
      const ctx = context(cwd, base.modelRegistry, async () => { confirmations++; return true; });
      const [tool] = createReviewTools(ctx, ["write"], controller.signal, new SecretRedactor());
      controller.abort();
      await assert.rejects(tool.execute("cancelled", { path: "cancelled.txt", content: "late" }), /cancelled/);
      assert.equal(confirmations, 0);
      await assert.rejects(readFile(join(cwd, "cancelled.txt")), { code: "ENOENT" });
    });
  });
});

test("offline redactor initialization captures registered and stored credentials without resolving or refreshing provider auth", async () => {
  await isolatedWorkspace(async cwd => {
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    const oldSecret = process.env.DECISION_TEST_SECRET;
    process.env.PI_CODING_AGENT_DIR = cwd;
    process.env.DECISION_TEST_SECRET = "test-environment-secret-1q2w3e";
    await writeFile(join(cwd, "auth.json"), JSON.stringify({ "local-review": { type: "oauth", access: "stored-access-5r6t7y8u", refresh: "stored-refresh-9i0o1p2a", expires: 0 } }));
    try {
      let calls = 0;
      await localReviewer(cwd, (_request, response) => { calls++; completion(response, accepted); }, async ctx => {
        const redactor = await createSecretRedactor(ctx);
        const text = redactor.redactText([providerKey, providerHeader, "stored-access-5r6t7y8u", "stored-refresh-9i0o1p2a", "test-environment-secret-1q2w3e"].join("\n"));
        assert.doesNotMatch(text, /local-provider|local-header|stored-access|stored-refresh|test-environment/);
        assert.equal(calls, 0);
      });
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      if (oldSecret === undefined) delete process.env.DECISION_TEST_SECRET; else process.env.DECISION_TEST_SECRET = oldSecret;
    }
  });
});

test("cancelling an approved running shell kills its delayed mutation", { skip: process.platform === "win32" }, async () => {
  await isolatedWorkspace(async cwd => {
    await localReviewer(cwd, (_request, response) => completion(response, accepted), async base => {
      const controller = new AbortController();
      const ctx = context(cwd, base.modelRegistry, async () => true);
      const [tool] = createReviewTools(ctx, ["bash"], controller.signal, new SecretRedactor());
      let started!: () => void;
      const waiting = new Promise<void>(resolve => { started = resolve; });
      const pending = tool.execute("shell", { command: "printf 'started\\n'; sleep 0.2; printf 'late' > shell-late.txt" }, undefined, update => {
        if (update.content.some(block => block.type === "text" && block.text.includes("started"))) started();
      });
      const rejection = assert.rejects(pending, /cancelled/);
      await waiting;
      controller.abort();
      await rejection;
      await new Promise(resolve => setTimeout(resolve, 300));
      await assert.rejects(readFile(join(cwd, "shell-late.txt")), { code: "ENOENT" });
    });
  });
});
