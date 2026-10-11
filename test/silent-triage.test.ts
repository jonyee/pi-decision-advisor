import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import decisionAdvisor from "../src/index.ts";
import type { ReviewFinding, ReviewResult } from "../src/types.ts";
import { numberReviewFindings } from "../src/review-feedback.ts";

function getRenderers() {
  const renderers = new Map<string, (...args: any[]) => unknown>();
  decisionAdvisor({
    registerEntryRenderer: (type: string, renderer: (...args: any[]) => unknown) => renderers.set(type, renderer),
    on: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
  return renderers;
}

test("triage renderers hide all entries, including resumed verbose reports; advisor renderers remain", () => {
  const renderers = getRenderers();
  for (const type of ["decision-report", "decision-error"]) {
    for (const expanded of [false, true]) {
      assert.equal(renderers.get(type)!({ data: { flagged: ["correctness"], verbose: true, reason: "authentication" } }, { expanded }, {}), undefined);
    }
  }
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  const review = renderers.get("decision-review")!({ data: { turn: 1, result: { verdict: "revise", findings: [{ severity: "concern", explanation: "Preserved finding", evidence: "file:1", recommendation: "Fix it" }] } } }, { expanded: false }, theme);
  assert.ok(review);
  for (const verdict of ["accept", "cannot_tell"]) {
    const emptyReview = renderers.get("decision-review")!({ data: { turn: 2, result: { verdict, findings: [] } } }, { expanded: false }, theme) as { render(width: number): string[] };
    const lines = emptyReview.render(200);
    assert.equal(lines.length, 1, "empty reviews occupy one line");
    assert.match(lines[0], /Advisor review \(2\): The advisor was requested/);
  }
  const failure = renderers.get("decision-review-error")!({ data: { text: "Advisor review (2): Failed (timeout). Preserved reviewer failure" } }, {}, theme) as { render(width: number): string[] };
  assert.equal(failure.render(200).length, 1);
});

test("review colors reflect verdict and worst severity, including collapsed blockers", () => {
  const renderer = getRenderers().get("decision-review")!;
  const finding = (severity: ReviewFinding["severity"]): ReviewFinding => ({ severity, explanation: `${severity} explanation`, evidence: "file:1", recommendation: "Fix it" });
  const concern = finding("concern");
  const blocker = finding("blocker");
  const cases: { verdict: ReviewResult["verdict"]; findings: ReviewFinding[]; color: string }[] = [
    { verdict: "accept", findings: [], color: "success" },
    { verdict: "cannot_tell", findings: [], color: "warning" },
    { verdict: "revise", findings: [concern], color: "warning" },
    { verdict: "revise", findings: [blocker], color: "error" },
    { verdict: "cannot_tell", findings: [concern], color: "warning" },
    { verdict: "cannot_tell", findings: [blocker], color: "error" },
    { verdict: "revise", findings: [concern, concern, concern, blocker], color: "error" },
  ];
  for (const { verdict, findings, color } of cases) {
    for (const expanded of [false, true]) {
      const calls: { color: string; text: string }[] = [];
      const theme = {
        fg: (color: string, text: string) => { calls.push({ color, text }); return text; },
        bold: (text: string) => text,
      } as Theme;
      const result = numberReviewFindings({ model: "reviewer", verdict, findings }, 2);
      const component = renderer({ data: { turn: 2, result } }, { expanded }, theme) as { render(width: number): string[] };
      const lines = component.render(200).join("\n");
      if (result.findings.length > 3) {
        assert.equal(lines.includes("B-204"), expanded, "expansion retains original finding numbering");
      }
      assert.equal(calls[0].color, color, `${verdict} heading (expanded=${expanded})`);
      assert.match(calls[0].text, /^Advisor review \(2\)/);
      for (const item of expanded ? result.findings : result.findings.slice(0, 3)) {
        assert.ok(calls.some(call => call.color === (item.severity === "blocker" ? "error" : "warning")
          && call.text === `${item.id} [${item.severity.toUpperCase()}] ${item.explanation}`), "finding ID, label and explanation share severity color");
      }
      assert.ok(calls.every(call => call.color !== "customMessageLabel"), "no generic pink headings");
    }
  }
});

test("review failure notices use the error color, including stored entries without a category", () => {
  const renderer = getRenderers().get("decision-review-error")!;
  for (const category of [undefined, "timeout", "cancelled", "configuration", "provider", "tool", "response"]) {
    const calls: string[] = [];
    const theme = {
      fg: (color: string, text: string) => { calls.push(color); return text; },
      bold: (text: string) => text,
    } as Theme;
    const component = renderer({ data: { text: `Advisor review (2): Failed (${category ?? "timeout"}). No reviewer findings were applied.`, category } }, {}, theme) as { render(width: number): string[] };
    assert.equal(component.render(200).length, 1);
    assert.deepEqual(calls, ["error"]);
  }
});
