import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { validateDecisionOptions } from "../src/config.js";
import { AzureDecisionClient, COGNITIVE_SCOPE, CurrentEvidenceOverflowError, DecisionError, MAX_EVIDENCE_TOKENS } from "../src/decision.js";
import { criterionIds, type DecisionOptions, type TurnEvidence, type Verdict } from "../src/types.js";
import { countEvidenceTokens } from "../src/evidence-tokens.ts";

const evidence: TurnEvidence = {
  instructions: ["Return an accurate answer without claiming unperformed checks."],
  userRequest: "What is 2 + 2?",
  recentHistory: [],
  assistant: { content: "4", final: true },
  toolResults: [],
};
const defaults: DecisionOptions = { endpoint: "https://example.invalid", deployment: "test-decision", passThreshold: 0.8, timeoutMs: 1_000, credentialMode: "azure-cli" };
const credential = { getToken: async () => ({ token: "isolated-test-token" }) };
function answer(choice: Verdict = "pass", probability = 0.97) {
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(["pass", "concern", "blocker", "cannot_tell"].map(label => [label, label === choice ? probability : (1 - probability) / 3])),
    confidence: 0.9,
  };
}
function payload(): { answers: Record<string, ReturnType<typeof answer>> } {
  return { answers: Object.fromEntries(criterionIds.map(id => [id, answer()])) };
}
async function local(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, run: (endpoint: string) => Promise<void>) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => { response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
function client(endpoint: string, options: Partial<DecisionOptions> = {}) {
  return new AzureDecisionClient({ ...defaults, ...options, endpoint }, { credential, allowTestLoopback: true });
}
function rejectsCode(code: string) {
  return (error: unknown) => error instanceof DecisionError && error.code === code;
}
function json(response: ServerResponse, body: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}


test("flags are independent and require pass choice AND probability threshold", async () => {
  const result = payload();
  result.answers.adherence = answer("pass", 0.8);
  result.answers.groundedness = answer("pass", 0.79);
  result.answers.correctness = answer("concern", 0.85);
  result.answers.safety = answer("blocker", 0.9);
  result.answers.progress = answer("cannot_tell", 0.9);
  await local((_request, response) => json(response, result), async endpoint => {
    const report = await client(endpoint).evaluate(evidence, 1);
    assert.deepEqual(report.flagged, ["groundedness", "correctness", "safety", "progress"]);
    assert.equal(report.criteria.progress.choice, "cannot_tell");
    const relaxed = await client(endpoint, { passThreshold: 0.7 }).evaluate(evidence, 1);
    assert.deepEqual(relaxed.flagged, ["correctness", "safety", "progress"]);
  });
});

const malformedCases: Array<[string, (value: ReturnType<typeof payload>) => void]> = [
  ["missing criterion", value => { delete value.answers.safety; }],
  ["unsupported answer type", value => { value.answers.safety.type = "bool"; }],
  ["unsupported choice", value => { Object.assign(value.answers.safety, { choice: "yes" }); }],
  ["missing probability", value => { delete value.answers.safety.probabilities.cannot_tell; }],
  ["extra probability", value => { value.answers.safety.probabilities.extra = 0; }],
  ["negative probability", value => { value.answers.safety.probabilities.concern = -0.1; }],
  ["probability over one", value => { value.answers.safety.probabilities.pass = 1.1; }],
  ["nonnumeric probability", value => { Object.assign(value.answers.safety.probabilities, { pass: "0.97" }); }],
  ["null probability", value => { Object.assign(value.answers.safety.probabilities, { pass: null }); }],
  ["unnormalized probabilities", value => { value.answers.safety.probabilities.concern = 0.4; }],
  ["choice contradicts maximum", value => { value.answers.safety.choice = "blocker"; }],
  ["missing confidence", value => { Reflect.deleteProperty(value.answers.safety, "confidence"); }],
  ["invalid confidence", value => { value.answers.safety.confidence = 1.1; }],
];
for (const [name, mutate] of malformedCases) {
  test(`rejects ${name} without a partial/safe report`, async () => {
    const result = payload();
    mutate(result);
    await local((_request, response) => json(response, result), async endpoint => {
      await assert.rejects(client(endpoint).evaluate(evidence, 1), rejectsCode("response"));
    });
  });
}

test("accepts ordinary rounded probabilities and maximum ties", async () => {
  const result = payload();
  result.answers.safety = { type: "choice", choice: "pass", probabilities: { pass: 0.5, concern: 0.5, blocker: 0, cannot_tell: 0 }, confidence: 0 };
  result.answers.progress.probabilities = { pass: 0.97, concern: 0.0099, blocker: 0.0099, cannot_tell: 0.0099 };
  await local((_request, response) => json(response, result), async endpoint => {
    const report = await client(endpoint).evaluate(evidence, 1);
    assert.deepEqual(report.flagged, ["safety"]);
  });
});

test("malformed JSON and service errors are sanitized, never copied into reports/errors", async () => {
  for (const status of [200, 401, 429, 500]) {
    await local((_request, response) => {
      response.writeHead(status);
      response.end("private-resource-test-marker");
    }, async endpoint => {
      await assert.rejects(client(endpoint).evaluate(evidence, 1), (error: unknown) => {
        assert.ok(error instanceof DecisionError);
        assert.equal(error.code, status === 200 ? "response" : "http");
        assert.equal(error.message.includes("private-resource-test-marker"), false);
        assert.equal(error.message.includes(endpoint), false);
        return true;
      });
    });
  }
});

test("redirects do not receive bearer credentials", async () => {
  let redirected = false;
  await local((_request, response) => { redirected = true; json(response, payload()); }, async target => {
    await local((_request, response) => { response.writeHead(307, { Location: target }); response.end(); }, async endpoint => {
      await assert.rejects(client(endpoint).evaluate(evidence, 1), rejectsCode("network"));
    });
  });
  assert.equal(redirected, false);
});

test("network response timeout and caller cancellation leave turn unassessed", async () => {
  await local(() => {}, async endpoint => {
    await assert.rejects(client(endpoint, { timeoutMs: 100 }).evaluate(evidence, 1), rejectsCode("timeout"));
    const controller = new AbortController();
    const pending = client(endpoint).evaluate(evidence, 1, controller.signal);
    controller.abort();
    await assert.rejects(pending, rejectsCode("cancelled"));
  });
});

test("timeout covers credential acquisition and late token cannot trigger inference", async () => {
  let resolveToken!: (token: { token: string }) => void;
  let calls = 0;
  await local((_request, response) => { calls++; json(response, payload()); }, async endpoint => {
    const delayed = new AzureDecisionClient({ ...defaults, endpoint, timeoutMs: 100 }, {
      allowTestLoopback: true,
      credential: { getToken: (scope, options) => {
        assert.equal(scope, COGNITIVE_SCOPE);
        assert.ok(options?.abortSignal);
        return new Promise(resolve => { resolveToken = resolve; });
      } },
    });
    await assert.rejects(delayed.evaluate(evidence, 1), rejectsCode("timeout"));
    resolveToken({ token: "isolated-test-token" });
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(calls, 0);
});

test("already cancelled turns never request a token", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const instance = new AzureDecisionClient(defaults, { credential: { getToken: async () => { calls++; return null; } } });
  await assert.rejects(instance.evaluate(evidence, 1, controller.signal), rejectsCode("cancelled"));
  assert.equal(calls, 0);
});

test("credential errors are sanitized and do not reach inference", async () => {
  for (const provider of [
    { getToken: async () => null },
    { getToken: async () => { throw new Error("private-tenant-test-marker isolated-test-token"); } },
  ]) {
    const instance = new AzureDecisionClient(defaults, { credential: provider });
    await assert.rejects(instance.evaluate(evidence, 1), (error: unknown) => {
      assert.ok(error instanceof DecisionError);
      assert.equal(error.code, "authentication");
      assert.equal(error.message.includes("private-tenant-test-marker"), false);
      assert.equal(error.message.includes("isolated-test-token"), false);
      return true;
    });
  }
});

test("current-only overflow and serialization errors are distinct and rejected before auth or network", async () => {
  let credentialCalls = 0;
  let fetchCalls = 0;
  const instance = new AzureDecisionClient(defaults, {
    credential: { getToken: async () => { credentialCalls++; return null; } },
    fetch: async () => { fetchCalls++; return new Response(JSON.stringify(payload())); },
  });
  for (const userRequest of ["7".repeat(MAX_EVIDENCE_TOKENS), "界".repeat(MAX_EVIDENCE_TOKENS)]) {
    const oversized = { ...evidence, userRequest };
    await assert.rejects(instance.evaluate(oversized, 1), (error: unknown) => {
      assert.ok(error instanceof CurrentEvidenceOverflowError);
      assert.equal(error.code, "evidence_current_overflow");
      assert.equal(error.currentTokens, countEvidenceTokens(JSON.stringify(oversized)));
      assert.equal(error.maxTokens, MAX_EVIDENCE_TOKENS);
      assert.equal(error.message.includes(userRequest), false);
      return true;
    });
  }
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  for (const invalid of [{ ...evidence, toolResults: cyclic }, { ...evidence, recentHistory: cyclic }, { ...evidence, assistant: { toJSON() { throw new Error("private-serialization-marker"); } } }]) {
    await assert.rejects(instance.evaluate(invalid, 1), (error: unknown) => {
      assert.ok(error instanceof DecisionError);
      assert.equal(error.code, "evidence_serialization");
      assert.equal(error.message.includes("private-serialization-marker"), false);
      return true;
    });
  }
  await assert.rejects(instance.evaluate(evidence, 0), rejectsCode("evidence"));
  assert.equal(credentialCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("standalone scoring options enforce numeric bounds without persisted host deadlines", () => {
  for (const passThreshold of [0.5, 1]) {
    assert.equal(validateDecisionOptions({ ...defaults, passThreshold }).passThreshold, passThreshold);
  }
  for (const passThreshold of [NaN, Infinity, 0.49, 1.01]) {
    assert.throws(() => validateDecisionOptions({ ...defaults, passThreshold }));
  }
  for (const timeoutMs of [100, 120_000]) {
    assert.equal(validateDecisionOptions({ ...defaults, timeoutMs }).timeoutMs, timeoutMs);
  }
  for (const timeoutMs of [99, 120_001, 100.5, Infinity]) {
    assert.throws(() => validateDecisionOptions({ ...defaults, timeoutMs }));
  }
});

test("unsafe endpoints and malformed deployment names are rejected before credentials", () => {
  for (const endpoint of ["http://example.invalid", "http://127.0.0.1", "ftp://example.invalid", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid?key=test", "https://example.invalid#test", "not-a-url"]) {
    assert.throws(() => new AzureDecisionClient({ ...defaults, endpoint }, { credential }));
  }
  assert.throws(() => new AzureDecisionClient({ ...defaults, endpoint: "http://example.invalid" }, { credential, allowTestLoopback: true }));
  assert.throws(() => new AzureDecisionClient({ ...defaults, endpoint: "http://127.0.0.1" }, { allowTestLoopback: true }));
  for (const deployment of ["", "bad/name", "bad name", "x".repeat(129)]) {
    assert.throws(() => new AzureDecisionClient({ ...defaults, deployment }, { credential }));
  }
  for (const passThreshold of [NaN, Infinity, 0.49, 1.01]) {
    assert.throws(() => new AzureDecisionClient({ ...defaults, passThreshold }, { credential }));
  }
});

test("nonfinite JSON numeric values are rejected rather than accepted as probabilities", async () => {
  for (const numeric of ["1e309", "-1e309"]) {
    const body = JSON.stringify(payload()).replace('"pass":0.97', `"pass":${numeric}`);
    await local((_request, response) => { response.writeHead(200); response.end(body); }, async endpoint => {
      await assert.rejects(client(endpoint).evaluate(evidence, 1), rejectsCode("response"));
    });
  }
});

test("deadline includes streaming response body, not only receipt of headers", async () => {
  await local((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"answers":');
  }, async endpoint => {
    await assert.rejects(client(endpoint, { timeoutMs: 100 }).evaluate(evidence, 1), rejectsCode("timeout"));
  });
});

test("caller cancellation interrupts credential acquisition without inference", async () => {
  let fetchCalls = 0;
  const controller = new AbortController();
  const instance = new AzureDecisionClient(defaults, {
    credential: { getToken: async () => new Promise<{ token: string } | null>(() => {}) },
    fetch: async () => { fetchCalls++; return new Response(JSON.stringify(payload())); },
  });
  const pending = instance.evaluate(evidence, 1, controller.signal);
  controller.abort();
  await assert.rejects(pending, rejectsCode("cancelled"));
  assert.equal(fetchCalls, 0);
});

test("evidence exactly at the application budget is sent intact", async () => {
  const base = { ...evidence, userRequest: "" };
  const remaining = MAX_EVIDENCE_TOKENS - countEvidenceTokens(JSON.stringify({ ...base, userRequest: "7" })) + 1;
  const bounded = { ...base, userRequest: "7".repeat(remaining) };
  let observedState = "";
  await local(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const sent = JSON.parse(body);
    observedState = sent.state;
    assert.deepEqual(JSON.parse(sent.state), bounded);
    json(response, payload());
  }, async endpoint => {
    const report = await client(endpoint).evaluate(bounded, 1);
    assert.deepEqual(report.flagged, []);
    await assert.rejects(client(endpoint).evaluate({ ...bounded, userRequest: `${bounded.userRequest}7` }, 2), rejectsCode("evidence_current_overflow"));
  });
  assert.equal(countEvidenceTokens(observedState), MAX_EVIDENCE_TOKENS);
});

test("standalone scoring sends bounded newest history without removing current fields", async () => {
  const older = { role: "assistant", content: "7".repeat(MAX_EVIDENCE_TOKENS) };
  const newer = { role: "user", content: "Use the latest output." };
  const original = { ...evidence, recentHistory: [older, newer] };
  let observedState = "";
  await local(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    observedState = JSON.parse(body).state;
    assert.deepEqual(JSON.parse(observedState), { ...evidence, recentHistory: [newer] });
    json(response, payload());
  }, async endpoint => {
    await client(endpoint).evaluate(original, 1);
  });
  assert.ok(countEvidenceTokens(observedState) <= MAX_EVIDENCE_TOKENS);
  assert.deepEqual(original.recentHistory, [older, newer]);
});
