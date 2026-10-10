import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toDecisionOptions, type DecisionSettings } from "./config.ts";
import { AzureDecisionClient, DecisionError } from "./decision.ts";
import { withLoading } from "./loading-ui.ts";
import { criterionIds, type DecisionReport, type DecisionSmokeResult } from "./types.ts";

export async function showDecisionStatus(ctx: ExtensionCommandContext, settings: DecisionSettings, last?: { turn: number; report?: DecisionReport }, signal?: AbortSignal): Promise<void> {
  let smoke: DecisionSmokeResult | undefined;
  let state: "not_configured" | "passed" | "failed" | "error" = "not_configured";
  let errorCode: string | undefined;
  if (settings.endpoint && settings.deployment) {
    try {
      const client = new AzureDecisionClient(toDecisionOptions(settings));
      smoke = await withLoading(ctx, "Testing Decision model…", requestSignal => client.smokeTest(requestSignal), signal);
      if (smoke === undefined || signal?.aborted) return;
      state = smoke.passed ? "passed" : "failed";
    } catch (error) {
      if (signal?.aborted) return;
      state = "error";
      errorCode = error instanceof DecisionError ? error.code : "configuration";
    }
  }
  const lines = [
    `Automatic turn review: ${settings.enabled ? "on" : "off"}`,
    `Verbose output: ${settings.verbose ? "on" : "off"}`,
    `Scoring deployment: ${settings.deployment || "not configured"}`,
    `Escalation reviewer: ${settings.reviewModel || "not configured"}`,
    `Reviewer tools: ${settings.reviewTools || "none"}`,
    `Prior review summaries: up to ${settings.reviewHistoryTurns}`,
    `Reviewer instructions: ${settings.reviewInstructions ? "configured" : "none"}`,
    `Pass threshold: ${settings.passThreshold}`,
    `Smoke test: ${state.replaceAll("_", " ")}${errorCode ? ` (${errorCode})` : ""}`,
  ];
  if (smoke) {
    lines.push(`Matching reply: ${smoke.checks.matching.choice}; P(match) ${(smoke.checks.matching.probabilities.match * 100).toFixed(1)}%`);
    lines.push(`Mismatching reply: ${smoke.checks.mismatching.choice}; P(mismatch) ${(smoke.checks.mismatching.probabilities.mismatch * 100).toFixed(1)}%`);
  }
  if (state === "not_configured") lines.push("Choose an existing scoring deployment in /decision settings.");
  if (!settings.reviewModel) lines.push("Choose an explicit reviewer provider/model in /decision settings before requesting an independent review.");
  if (state === "error") lines.push("Check the saved provider, credential mode and Azure login; no escalation reviewer was invoked.");
  if (state === "failed") lines.push("The endpoint responded but did not distinguish the two smoke cases; no escalation reviewer was invoked.");
  if (last?.report) {
    lines.push(`Last primary turn: ${last.turn}`);
    for (const id of criterionIds) {
      const check = last.report.criteria[id];
      lines.push(`${id}: ${check.choice}; P(pass) ${(check.probabilities.pass * 100).toFixed(1)}%`);
    }
  } else lines.push(last ? `Last primary turn ${last.turn}: not evaluated.` : "No primary turn recorded yet.");
  lines.push("Smoke tests use at most one synthetic Decision request and never invoke the escalation reviewer.");
  const record = { type: "decision_status", enabled: settings.enabled, verbose: settings.verbose, deployment: settings.deployment, reviewer: settings.reviewModel, reviewerTools: settings.reviewTools, reviewHistoryTurns: settings.reviewHistoryTurns, passThreshold: settings.passThreshold, smoke: { state, result: smoke, errorCode }, last: last?.report };
  if (ctx.mode === "json") console.log(JSON.stringify(record));
  else if (ctx.mode === "print") console.log(lines.join("\n"));
  else await ctx.ui.select(`Decision advisor status\n\n${lines.join("\n")}`, ["Close"]);
}
