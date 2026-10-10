import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverDecisionDeployments } from "./azure-models.ts";
import { normalizeDecisionSettings, toDecisionOptions, type DecisionSettings } from "./config.ts";
import { loadDecisionSettings, saveDecisionSettings } from "./settings.ts";
import { withLoading } from "./loading-ui.ts";
import { ELEVATED_REVIEW_TOOLS, parseReviewTools, REVIEW_TOOL_OPTIONS } from "./review-tools.ts";

async function select(ctx: ExtensionCommandContext, title: string, options: ReadonlyArray<{ label: string; description?: string }>): Promise<string | undefined> {
  const rows = options.map(option => option.description ? `${option.label} — ${option.description}` : option.label);
  const choice = await ctx.ui.select(title, rows);
  return choice === undefined ? undefined : options[rows.indexOf(choice)]?.label;
}

async function selectScoringProvider(ctx: ExtensionCommandContext, draft: DecisionSettings): Promise<DecisionSettings | undefined> {
  const method = await select(ctx, "Scoring model — Microsoft-Decision-1", [
    { label: "Choose existing Azure deployment", description: "Read-only discovery in the Azure CLI's active subscription; requires az login and account read permission." },
    { label: "Enter endpoint and deployment manually", description: "Use an existing Microsoft-Decision-1 deployment; no cloud resources will be created." },
  ]);
  if (method === undefined) return undefined;
  if (method === "Choose existing Azure deployment") {
    try {
      const deployments = await withLoading(ctx, "Loading Azure deployments…", signal => discoverDecisionDeployments(undefined, signal));
      if (deployments === undefined) return undefined;
      if (deployments.length) {
        const rows = deployments.map((deployment, index) => `${index + 1}. ${deployment.model}${deployment.version ? ` ${deployment.version}` : ""} · ${deployment.location} · ${deployment.deployment}`);
        const choice = await ctx.ui.select("Choose existing scoring deployment (no cloud changes)", rows);
        if (choice === undefined) return undefined;
        const selected = deployments[rows.indexOf(choice)];
        if (!selected) return undefined;
        return { ...draft, endpoint: selected.endpoint, deployment: selected.deployment };
      }
      ctx.ui.notify("No healthy existing Microsoft-Decision-1 deployment was found. Enter the endpoint and deployment manually, or cancel.", "warning");
    } catch {
      ctx.ui.notify("Azure discovery is unavailable. Check Azure login and account read permission, or enter the endpoint and deployment manually.", "warning");
    }
  }
  const endpoint = await ctx.ui.input("Account HTTPS endpoint (blank with blank deployment leaves scoring unconfigured)", draft.endpoint);
  if (endpoint === undefined) return undefined;
  const deployment = await ctx.ui.input("Existing Microsoft-Decision-1 deployment name", draft.deployment);
  if (deployment === undefined) return undefined;
  const next = normalizeDecisionSettings({ ...draft, endpoint, deployment });
  if (next.endpoint || next.deployment) toDecisionOptions(next);
  return next;
}

async function selectReviewerModel(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
  const models = ctx.modelRegistry.getAvailable();
  const selectors = [...new Set(models.map(model => `${model.provider}/${model.id}`))];
  if (!selectors.length) ctx.ui.notify("No authenticated reviewer model is available. Configure a Pi provider before selecting an independent reviewer.", "warning");
  const clear = "Leave reviewer unconfigured";
  const choice = await ctx.ui.select(`Reviewer model — current: ${current || "not configured"}`, [clear, ...selectors]);
  return choice === clear ? "" : choice;
}

const ELEVATED_GRANT_WARNING = "These tools can execute commands or modify files, resources or program state. Reviewer tool grants are not a security sandbox; granted tools execute with the Pi process's permissions.";

async function selectReviewerTools(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
  const selected = new Set(parseReviewTools(current));
  for (;;) {
    const options = REVIEW_TOOL_OPTIONS.map(tool => ({
      label: `${selected.has(tool.name) ? "[on]" : "[off]"} ${tool.name}`,
      description: tool.description,
    }));
    const choice = await select(ctx, "Reviewer tools — unavailable selected tools fail explicitly", [
      ...options,
      { label: "Done", description: "Apply to the unsaved draft; no tools selected means no grants." },
      { label: "Cancel", description: "Discard changes in this tool picker." },
    ]);
    if (choice === undefined || choice === "Cancel") return undefined;
    if (choice === "Done") return parseReviewTools([...selected].join(",")).join(",");
    const index = options.findIndex(option => option.label === choice);
    if (index < 0) continue;
    const name = REVIEW_TOOL_OPTIONS[index]!.name;
    if (selected.has(name)) {
      selected.delete(name);
    } else {
      if (ELEVATED_REVIEW_TOOLS.includes(name) && !await ctx.ui.confirm(`Grant reviewer tool: ${name}?`, ELEVATED_GRANT_WARNING)) continue;
      selected.add(name);
    }
  }
}

/** Native TUI/RPC dialogs. Nothing is persisted until the user explicitly confirms Save. */
export async function configureDecision(ctx: ExtensionCommandContext): Promise<DecisionSettings | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Configure preferences in interactive Pi or RPC with /decision settings. The extension stores user preferences in the Pi agent directory's decision-advisor.json; trusted .pi/decision-advisor.json project overrides are read-only.", "warning");
    return undefined;
  }
  const options = { projectTrusted: ctx.isProjectTrusted() };
  let draft = await loadDecisionSettings(ctx.cwd, options);
  if (!draft.reviewModel) ctx.ui.notify("Reviewer model is not configured. Select an explicit provider/model before requesting an independent review.", "warning");
  const baselineTools = new Set(parseReviewTools(draft.reviewTools));
  for (;;) {
    const choice = await select(ctx, "Decision extension reviewer preferences — edits are not saved yet", [
      { label: "Automatic review", description: draft.enabled ? "On: triage after each primary turn." : "Off: only explicitly requested reviews." },
      { label: "Scoring model", description: draft.endpoint && draft.deployment ? `${draft.deployment} · ${draft.endpoint}` : "Not configured; choose an existing Azure deployment or enter it manually." },
      { label: "Reviewer model", description: draft.reviewModel || "Not configured; choose an authenticated provider/model." },
      { label: "Tools", description: `${draft.reviewTools || "None"} · only selected grants; unavailable tools fail explicitly.` },
      { label: "Instructions", description: draft.reviewInstructions ? "Saved multiline instructions (up to 8192 UTF-8 bytes); open editor to view or change." : "No additional reviewer instructions; open multiline editor." },
      { label: "Review history entries", description: `${draft.reviewHistoryTurns} (0–8) · completed prior summaries in this session only.` },
      { label: "Azure credentials", description: draft.credentialMode === "azure-cli" ? "Azure CLI identity (az login)" : "DefaultAzureCredential" },
      { label: "Pass threshold", description: `${draft.passThreshold} · lower means fewer reviews; higher is stricter (0.5–1).` },
      { label: "Scoring timeout", description: `${draft.timeoutMs} ms (100–20000).` },
      { label: "Automatic reviewer timeout", description: `${draft.advisorTimeoutMs} ms (100–20000).` },
      { label: "Verbose output", description: draft.verbose ? "On: all Decision scores and full Decision JSON; reviewer notes stay concise." : "Off: silent passes, compact failed scores and concise reviewer notes." },
      { label: "Save", description: "Persist validated user preferences; Azure credentials are never saved." },
      { label: "Cancel", description: "Discard this draft without changing preferences." },
    ]);
    if (choice === undefined || choice === "Cancel") return undefined;
    try {
      if (choice === "Automatic review") {
        draft = { ...draft, enabled: !draft.enabled };
      } else if (choice === "Scoring model") {
        const next = await selectScoringProvider(ctx, draft);
        if (next) draft = next;
      } else if (choice === "Reviewer model") {
        const reviewModel = await selectReviewerModel(ctx, draft.reviewModel);
        if (reviewModel !== undefined) draft = normalizeDecisionSettings({ ...draft, reviewModel });
      } else if (choice === "Tools") {
        const reviewTools = await selectReviewerTools(ctx, draft.reviewTools);
        if (reviewTools !== undefined) draft = normalizeDecisionSettings({ ...draft, reviewTools });
      } else if (choice === "Instructions") {
        const reviewInstructions = await ctx.ui.editor("Extension reviewer instructions (up to 8192 UTF-8 bytes)", draft.reviewInstructions);
        if (reviewInstructions !== undefined) draft = normalizeDecisionSettings({ ...draft, reviewInstructions });
      } else if (choice === "Review history entries") {
        const value = await ctx.ui.input("Completed review history entries (integer 0–8; 0 disables)", String(draft.reviewHistoryTurns));
        if (value !== undefined) {
          if (!/^\d+$/.test(value.trim())) throw new Error("Enter an integer from 0 to 8.");
          draft = normalizeDecisionSettings({ ...draft, reviewHistoryTurns: Number(value.trim()) });
        }
      } else if (choice === "Azure credentials") {
        const mode = await select(ctx, "Azure credential mode", [
          { label: "Azure CLI identity", description: "Use the signed-in az login identity (recommended); no custom environment settings." },
          { label: "DefaultAzureCredential", description: "Use Azure SDK credential discovery, such as managed identity or development credentials." },
        ]);
        if (mode !== undefined) draft = { ...draft, credentialMode: mode === "Azure CLI identity" ? "azure-cli" : "default" };
      } else if (choice === "Pass threshold" || choice === "Scoring timeout" || choice === "Automatic reviewer timeout") {
        const key = choice === "Pass threshold" ? "passThreshold" : choice === "Scoring timeout" ? "timeoutMs" : "advisorTimeoutMs";
        const title = choice === "Pass threshold" ? "Pass threshold (0.5–1; lower means fewer reviews, higher is stricter)" : `${choice} in milliseconds (100–20000)`;
        const value = await ctx.ui.input(title, String(draft[key]));
        if (value !== undefined) {
          if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) throw new Error("Enter a decimal number without units.");
          draft = normalizeDecisionSettings({ ...draft, [key]: Number(value.trim()) });
        }
      } else if (choice === "Verbose output") {
        draft = { ...draft, verbose: !draft.verbose };
      } else if (choice === "Save") {
        const validated = normalizeDecisionSettings({ ...draft });
        if (validated.endpoint || validated.deployment) toDecisionOptions(validated);
        const addedElevated = parseReviewTools(validated.reviewTools).filter(tool => ELEVATED_REVIEW_TOOLS.includes(tool) && !baselineTools.has(tool));
        const grantWarning = addedElevated.length ? ` Newly granted elevated tools: ${addedElevated.join(", ")}. ${ELEVATED_GRANT_WARNING}` : "";
        const confirmed = await ctx.ui.confirm("Save Decision extension reviewer preferences?", `Save to the Pi agent directory's decision-advisor.json. Trusted project overrides may take precedence; effective preferences will be reloaded. No Azure credentials will be stored.${grantWarning}`);
        if (!confirmed) continue;
        const effective = await saveDecisionSettings(ctx.cwd, validated, options);
        const shadowed = (Object.keys(validated) as Array<keyof DecisionSettings>).filter(key => effective[key] !== validated[key]);
        ctx.ui.notify(shadowed.length
          ? `User preferences saved, but trusted project overrides take precedence for: ${shadowed.join(", ")}. The effective preferences have been reloaded.`
          : "Decision advisor user preferences saved.", shadowed.length ? "warning" : "info");
        if (!effective.reviewModel) ctx.ui.notify("Reviewer model remains unconfigured; choose an explicit provider/model before requesting an independent review.", "warning");
        return effective;
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Decision advisor preferences could not be updated.", "error");
    }
  }
}
