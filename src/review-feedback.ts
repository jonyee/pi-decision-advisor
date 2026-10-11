import type { ReviewFinding, ReviewResult } from "./types.ts";

/** Compact severity/turn/ordinal references; scoped to the current turn-counter run. */
export function numberReviewFindings(result: ReviewResult, turn: number): ReviewResult {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new RangeError("Review turn must be a positive safe integer.");
  return {
    ...result,
    findings: result.findings.map((finding, index) => ({
      ...finding,
      // Separate ordinals over 99 so turn 2/finding 101 cannot alias turn 21/finding 01.
      id: `${finding.severity === "blocker" ? "B" : "C"}-${turn}${index >= 99 ? "-" : ""}${String(index + 1).padStart(2, "0")}`,
    })),
  };
}

export function findingSummary(finding: ReviewFinding): string {
  return `${finding.id ? `${finding.id} ` : ""}[${finding.severity.toUpperCase()}] ${finding.explanation}`;
}

export function formatReview(result: ReviewResult, turn: number): string {
  if (!result.findings.length) return result.verdict === "accept"
    ? `Advisor review (${turn}): The advisor was requested but had no findings.`
    : `Advisor review (${turn}): The advisor was requested but could not determine whether a correction is needed.`;
  return [`Advisor review (${turn})`, ...result.findings.map(finding =>
    `${findingSummary(finding)}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`),
  ].join("\n\n");
}
