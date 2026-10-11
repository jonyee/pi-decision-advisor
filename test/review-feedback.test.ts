import assert from "node:assert/strict";
import { test } from "node:test";
import { findingSummary, formatReview, numberReviewFindings } from "../src/review-feedback.ts";
import { parseReview } from "../src/review-result.ts";
import { ReviewHistory } from "../src/review-history.ts";
import type { ReviewResult } from "../src/types.ts";

function review(): ReviewResult {
  return {
    model: "reviewer", verdict: "revise",
    findings: ["concern", "blocker"].map(severity => ({
      severity: severity as "concern" | "blocker", evidence: "file.ts:1", explanation: "Concrete issue", recommendation: "Fix it",
    })),
  };
}

test("finding IDs use severity, turn and two-digit ordinal without mutating the original review", () => {
  const raw = review();
  raw.findings[0].id = "model-supplied-duplicate";
  const numbered = numberReviewFindings(raw, 2);
  assert.deepEqual(numbered.findings.map(finding => finding.id), ["C-201", "B-202"]);
  assert.equal(raw.findings[0].id, "model-supplied-duplicate");
  assert.equal(raw.findings[1].id, undefined);
  assert.deepEqual(numberReviewFindings(raw, 2), numbered);
  assert.deepEqual(numberReviewFindings(numbered, 2), numbered);
  assert.notEqual(numberReviewFindings(raw, 3).findings[0].id, numbered.findings[0].id);
  assert.deepEqual(numberReviewFindings({ model: "reviewer", verdict: "accept", findings: [] }, 2).findings, []);
});

test("compact references preserve multi-digit turns and finding ordinals without wrapping", () => {
  const raw = review();
  assert.deepEqual(numberReviewFindings(raw, 13).findings.map(finding => finding.id), ["C-1301", "B-1302"]);
  raw.findings = Array.from({ length: 100 }, () => ({ ...raw.findings[0] }));
  const numbered = numberReviewFindings(raw, 2);
  assert.equal(numbered.findings[8].id, "C-209");
  assert.equal(numbered.findings[9].id, "C-210");
  assert.equal(numbered.findings[98].id, "C-299");
  assert.equal(numbered.findings[99].id, "C-2-100");
  assert.equal(new Set(numbered.findings.map(finding => finding.id)).size, 100);
  for (const turn of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => numberReviewFindings(raw, turn), /positive safe integer/);
  }
});

test("overflow ordinals cannot collide with compact references on another turn", () => {
  const raw = review();
  raw.findings = Array.from({ length: 101 }, () => ({ ...raw.findings[0] }));
  const turn2 = numberReviewFindings(raw, 2);
  const turn21 = numberReviewFindings(review(), 21);
  assert.equal(turn2.findings[100].id, "C-2-101");
  assert.equal(turn21.findings[0].id, "C-2101");
  assert.notEqual(turn2.findings[100].id, turn21.findings[0].id);
  const ids = [2, 21, 210].flatMap(turn => numberReviewFindings(raw, turn).findings.map(finding => finding.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("formatting and stored JSON retain the same finding references", () => {
  const numbered = numberReviewFindings(review(), 2);
  const stored = JSON.parse(JSON.stringify(numbered)) as ReviewResult;
  assert.equal(formatReview(stored, 2), formatReview(numbered, 2));
  assert.match(formatReview(stored, 2), /C-201 \[CONCERN\] Concrete issue/);
  assert.match(formatReview(stored, 2), /B-202 \[BLOCKER\] Concrete issue/);
  assert.equal(findingSummary(review().findings[0]), "[CONCERN] Concrete issue", "older unnumbered reviews remain readable");
});

test("bounded review history copies finding IDs and isolates mutations", () => {
  const history = new ReviewHistory();
  const result = numberReviewFindings(review(), 2);
  history.record({ turn: 2, userRequest: "Fix it", result }, 3);
  result.findings[0].id = "changed";
  const snapshot = history.snapshot(3, 3);
  assert.equal(snapshot[0].result.findings[0].id, "C-201");
  snapshot[0].result.findings[0].id = "also-changed";
  assert.equal(history.snapshot(3, 3)[0].result.findings[0].id, "C-201");
});

test("review parser ignores model-supplied reference IDs before extension numbering", () => {
  const raw = review();
  for (const finding of raw.findings) finding.id = "F-fake-1";
  const validated = parseReview(JSON.stringify(raw), "reviewer");
  assert.ok(validated.findings.every(finding => finding.id === undefined));
  assert.deepEqual(numberReviewFindings(validated, 2).findings.map(finding => finding.id), ["C-201", "B-202"]);
});
