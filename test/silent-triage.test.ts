import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import decisionAdvisor from "../src/index.ts";

test("triage renderers hide all entries, including resumed verbose reports; advisor renderers remain", () => {
  const renderers = new Map<string, (...args: any[]) => unknown>();
  decisionAdvisor({
    registerEntryRenderer: (type: string, renderer: (...args: any[]) => unknown) => renderers.set(type, renderer),
    on: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
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
