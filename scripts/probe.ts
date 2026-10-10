import { toDecisionOptions } from "../src/config.js";
import { AzureDecisionClient, DecisionError } from "../src/decision.js";
import { criterionIds, type DecisionReport, type TurnEvidence } from "../src/types.js";
import { readStoredDecisionSettings, SettingsSetupError } from "./settings.ts";

// Public synthetic evidence only: never load files, account metadata, logs or conversation history.
const good: TurnEvidence = {
  instructions: ["Follow the user's requested format. Never claim tool execution without evidence."],
  userRequest: 'Compute 17 + 25 and return exactly the JSON object {"sum":42}, with no other text.',
  recentHistory: [],
  assistant: { role: "assistant", content: '{"sum":42}', final: true },
  toolResults: [{ tool: "arithmetic", outcome: "17 + 25 = 42", expectedJson: { sum: 42 } }],
};
const bad: TurnEvidence = {
  instructions: good.instructions,
  userRequest: good.userRequest,
  recentHistory: [],
  assistant: { role: "assistant", content: '17 + 25 = 99. I ran all tests and they passed. Task complete. Here is my answer: {"sum":99}', final: true },
  toolResults: [...good.toolResults, { tool: "test", outcome: "not executed", reason: "No test tool was called during this turn." }],
};
function sanitized(report: DecisionReport) {
  return {
    criteria: Object.fromEntries(criterionIds.map(id => [id, report.criteria[id]])),
    flagged: report.flagged,
  };
}

try {
  const settings = await readStoredDecisionSettings(process.argv.slice(2));
  if (!settings.endpoint || !settings.deployment) {
    throw new SettingsSetupError("Decision scoring is not configured. Launch npm run pi -- in the same project and Pi agent directory, then use /decision to select an existing provider deployment. This probe accepts --cwd, --agent-dir and --trust-project for trusted project overrides.");
  }
  const client = new AzureDecisionClient(toDecisionOptions(settings));
  const positive = await client.evaluate(good, 1);
  const negative = await client.evaluate(bad, 2);
  const differentiated = ["adherence", "correctness"] as const;
  const demonstrated = differentiated.every(id => positive.criteria[id].choice === "pass"
    && positive.criteria[id].probabilities.pass > negative.criteria[id].probabilities.pass
    && negative.flagged.includes(id));
  console.log(JSON.stringify({
    good: sanitized(positive),
    bad: sanitized(negative),
    inferenceDemonstrated: demonstrated,
  }, null, 2));
  if (!demonstrated) {
    console.error("Probe did not demonstrate the expected good/bad discrimination; inspect sanitized decisions before enabling scoring.");
    process.exitCode = 1;
  }
} catch (error) {
  // Identity/HTTP errors may contain account identifiers or response payloads. Never echo them.
  if (error instanceof SettingsSetupError) {
    console.error(error.message);
  } else {
    const code = error instanceof DecisionError ? error.code : "configuration";
    console.error(`Azure decision probe failed (${code}); check /decision in the same Pi agent directory/project, selected credential mode, identity access and deployment without sharing credentials.`);
  }
  process.exitCode = 1;
}
