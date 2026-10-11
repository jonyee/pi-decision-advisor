export const criterionIds = ["adherence", "groundedness", "correctness", "safety", "progress"] as const;
export type CriterionId = typeof criterionIds[number];
export const verdicts = ["pass", "concern", "blocker", "cannot_tell"] as const;
export type Verdict = typeof verdicts[number];
export interface CriterionResult {
  choice: Verdict;
  probabilities: Record<Verdict, number>;
  confidence: number;
}
export interface TurnEvidence {
  instructions: string[];
  userRequest: string;
  recentHistory: unknown[];
  assistant: unknown;
  toolResults: unknown[];
}
export interface DecisionReport {
  turn: number;
  model: string;
  evaluatedAt: string;
  criteria: Record<CriterionId, CriterionResult>;
  flagged: CriterionId[];
}
export interface DecisionSmokeResult {
  model: string;
  passed: boolean;
  checks: {
    matching: { choice: "match" | "mismatch"; probabilities: Record<"match" | "mismatch", number>; confidence: number };
    mismatching: { choice: "match" | "mismatch"; probabilities: Record<"match" | "mismatch", number>; confidence: number };
  };
}
export interface ReviewFinding {
  /** Assigned by the extension after validation; absent in raw or older reviews. */
  id?: string;
  severity: "concern" | "blocker";
  evidence: string;
  explanation: string;
  recommendation: string;
}
export interface ReviewResult {
  model: string;
  verdict: "accept" | "revise" | "cannot_tell";
  findings: ReviewFinding[];
}
export interface DecisionOptions {
  endpoint: string;
  deployment: string;
  passThreshold: number;
  timeoutMs: number;
  credentialMode: "azure-cli" | "default";
}
