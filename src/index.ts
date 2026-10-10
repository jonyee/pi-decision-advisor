import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AzureDecisionClient, DecisionError } from "./decision.ts";
import { toDecisionOptions, type DecisionSettings } from "./config.ts";
import { buildEvidence } from "./evidence.ts";
import { reviewTurn, ReviewerConfigurationError } from "./review.ts";
import { criterionIds, type DecisionReport, type ReviewResult, type TurnEvidence } from "./types.ts";
import { loadDecisionSettings, saveDecisionSettings } from "./settings.ts";
import { configureDecision } from "./settings-ui.ts";
import { showDecisionStatus } from "./status-ui.ts";
import { ReviewHistory } from "./review-history.ts";
import { createSecretRedactor, type SecretRedactor } from "./secrets.ts";

interface ReviewedTurn {
  evidence: TurnEvidence;
  report?: DecisionReport;
  turn: number;
  assistantEntryId: string;
  settings: DecisionSettings;
  review?: Promise<void>;
  result?: ReviewResult;
}

function formatReport(report: DecisionReport, verbose = false): string {
  const rows = criterionIds.map(id => {
    const result = report.criteria[id];
    return `${id}: ${result.choice}; P(pass) ${(result.probabilities.pass * 100).toFixed(1)}%`;
  });
  return [`Decision feedback — turn ${report.turn}`, ...rows,
    report.flagged.length ? "Failed triage check. The escalation reviewer checks this turn automatically." : "All criteria passed the configured threshold.",
    ...(verbose ? [JSON.stringify(report, null, 2)] : []),
    "Scores classify supplied evidence; they are not explanations or proof of correctness."].join("\n");
}

function feedbackComponent(text: string, theme: Theme): Container {
  const [heading, ...lines] = text.split("\n");
  const component = new Container();
  component.addChild(new Text(theme.fg("customMessageLabel", theme.bold(heading)), 1, 0));
  component.addChild(new Text(theme.fg("customMessageText", lines.join("\n")), 1, 0));
  return component;
}

function formatReview(result: ReviewResult, turn: number): string {
  if (!result.findings.length) return result.verdict === "accept"
    ? `Decision reviewer — turn ${turn}\nThe advisor was requested but had no findings.`
    : `Decision reviewer — turn ${turn}\nThe advisor was requested but could not determine whether a correction is needed.`;
  return [`Decision reviewer — turn ${turn}`, ...result.findings.map(finding =>
    `[${finding.severity.toUpperCase()}] ${finding.explanation}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`),
  ].join("\n\n");
}

export default function decisionAdvisor(pi: ExtensionAPI) {
  let controller = new AbortController();
  let redactor: SecretRedactor | undefined;
  let client: AzureDecisionClient | undefined;
  let configurationError: string | undefined;
  let configuration: DecisionSettings | undefined;
  let last: ReviewedTurn | undefined;
  const reviews = new Set<Promise<void>>();
  const reviewHistory = new ReviewHistory();
  let turn = 0;

  const reset = () => {
    controller.abort();
    controller = new AbortController();
    last = undefined;
    reviews.clear();
    reviewHistory.clear();
    turn = 0;
  };
  const applySettings = (settings: DecisionSettings) => {
    reset();
    configuration = settings;
    client = undefined;
    configurationError = undefined;
    try { client = new AzureDecisionClient(toDecisionOptions(settings)); }
    catch { configurationError = "Decision scoring is not configured. Run /decision settings to choose the deployment."; }
  };
  const showError = (text: string, ctx: ExtensionContext, data: { turn: number; automatic: boolean }) => {
    pi.appendEntry("decision-review-error", { ...data, text });
    if (ctx.mode === "print") console.log(text);
  };
  const displayReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean) => {
    if (!captured.result) return;
    const content = formatReview(captured.result, captured.turn);
    pi.appendEntry("decision-review", { turn: captured.turn, assistantEntryId: captured.assistantEntryId, automatic, result: captured.result, content });
    if (ctx.mode === "print") console.log(content);
  };

  // Durable score/error entries never enter provider context and need no preview widget.
  pi.registerEntryRenderer<DecisionReport & { verbose?: boolean }>("decision-report", (entry, _options, theme) => {
    const report = entry.data;
    return report && (report.flagged.length || report.verbose) ? feedbackComponent(formatReport(report, report.verbose), theme) : undefined;
  });
  pi.registerEntryRenderer<{ turn: number; reason: string }>("decision-error", (entry, _options, theme) => entry.data
    ? feedbackComponent(`Decision feedback — turn ${entry.data.turn}\nStatus: not evaluated (${entry.data.reason}). No pass was recorded. The escalation reviewer checks this turn without a decision score.`, theme) : undefined);
  pi.registerEntryRenderer<{ text: string }>("decision-review-error", (entry, _options, theme) => entry.data ? feedbackComponent(entry.data.text, theme) : undefined);
  pi.registerEntryRenderer<{ turn: number; result: ReviewResult }>("decision-review", (entry, { expanded }, theme) => {
    if (!entry.data) return undefined;
    const { result, turn: reviewedTurn } = entry.data;
    const component = new Container();
    if (!result.findings.length) return feedbackComponent(formatReview(result, reviewedTurn), theme);
    component.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`Decision reviewer — turn ${reviewedTurn}`)), 1, 0));
    for (const finding of expanded ? result.findings : result.findings.slice(0, 3)) {
      const severity = theme.fg(finding.severity === "blocker" ? "error" : "warning", `[${finding.severity.toUpperCase()}]`);
      component.addChild(new Text(`${severity} ${finding.explanation}\n${theme.fg("dim", `Evidence: ${finding.evidence}`)}\nRecommendation: ${finding.recommendation}`, 1, 1));
    }
    if (!expanded && result.findings.length > 3) component.addChild(new Text(theme.fg("dim", `${result.findings.length - 3} more findings — expand transcript details to view.`), 1, 0));
    return component;
  });

  const startReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean): Promise<void> => {
    if (captured.review) return captured.review;
    const generation = controller.signal;
    const job = (async () => {
      const signal = AbortSignal.any([generation, AbortSignal.timeout(captured.settings.advisorTimeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
      try {
        if (!redactor) throw new Error("Secret redaction is unavailable.");
        const result = await reviewTurn(ctx, captured.evidence, captured.report, signal, {
          model: captured.settings.reviewModel,
          timeoutMs: captured.settings.advisorTimeoutMs,
          tools: captured.settings.reviewTools,
          instructions: captured.settings.reviewInstructions,
          history: reviewHistory.snapshot(captured.turn, captured.settings.reviewHistoryTurns),
        }, redactor);
        if (generation.aborted || ctx.signal?.aborted) return;
        captured.result = result;
        reviewHistory.record({ turn: captured.turn, userRequest: captured.evidence.userRequest, result }, captured.settings.reviewHistoryTurns);
        displayReview(captured, ctx, automatic);
      } catch (error) {
        if (generation.aborted || ctx.signal?.aborted) return;
        const detail = error instanceof ReviewerConfigurationError ? redactor?.redactText(error.message) ?? "Check reviewer configuration."
          : "Check the reviewer model, its Pi credentials and review timeout in /decision settings.";
        showError(`Escalation review failed — turn ${captured.turn}\nNo reviewer findings were applied. ${detail}`, ctx, { turn: captured.turn, automatic });
      }
    })();
    captured.review = job;
    reviews.add(job);
    void job.finally(() => reviews.delete(job)).catch(() => {});
    return job;
  };

  const initializeSettings = async (ctx: ExtensionContext) => {
    reset();
    configuration = undefined;
    client = undefined;
    redactor = undefined;
    configurationError = undefined;
    const generation = controller.signal;
    let enabled = true;
    try {
      const settings = await loadDecisionSettings(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
      enabled = settings.enabled;
      const nextRedactor = await createSecretRedactor(ctx);
      if (generation.aborted) return;
      redactor = nextRedactor;
      applySettings(settings);
    } catch { configurationError = "Decision settings or secret protection could not be loaded. Open /decision settings to configure them."; }
    if (configurationError && enabled) ctx.ui.notify(configurationError, "warning");
  };
  pi.on("session_start", (_event, ctx) => initializeSettings(ctx));
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  // Keep the canonical transcript ending in the primary answer: Pi print mode relies on
  // that. Project persisted review entries into requests only while their source turn
  // remains in context; compaction/branch edits must not resurrect obsolete findings.
  pi.on("context", (event, ctx) => {
    const active = new Set(ctx.sessionManager.buildSessionProjection().entries.filter(entry => entry.messages.some(message => message.role === "assistant")).map(entry => entry.sourceEntry.id));
    const advice = ctx.sessionManager.getBranch().flatMap(entry => {
      if (entry.type !== "custom" || entry.customType !== "decision-review") return [];
      const data: unknown = entry.data;
      return data && typeof data === "object" && "assistantEntryId" in data && typeof data.assistantEntryId === "string"
        && active.has(data.assistantEntryId) && "content" in data && typeof data.content === "string"
        ? [{ role: "custom" as const, customType: "decision-review-context", content: data.content, display: false, timestamp: Date.parse(entry.timestamp) }]
        : [];
    });
    const messages = [...event.messages];
    const userIndex = messages.findLastIndex(message => message.role === "user");
    messages.splice(userIndex < 0 ? messages.length : userIndex, 0, ...advice);
    return { messages };
  });
  pi.on("agent_before_settle", async () => { await Promise.allSettled([...reviews]); });
  pi.on("turn_end", async (event, ctx) => {
    if (!configuration?.enabled || event.outcome === "aborted") return;
    const generation = controller.signal;
    const signal = AbortSignal.any([generation, ...(ctx.signal ? [ctx.signal] : [])]);
    const settings = configuration;
    const scoringClient = client;
    const currentTurn = ++turn;
    const history = ctx.sessionManager.buildSessionProjection().messages;
    let captured: ReviewedTurn;
    try {
      redactor ??= await createSecretRedactor(ctx);
      signal.throwIfAborted();
      captured = { evidence: redactor.redactObject(buildEvidence([ctx.getSystemPrompt()], history, event.message, event.toolResults)), turn: currentTurn, assistantEntryId: event.messageEntryId, settings };
    } catch {
      if (signal.aborted) return;
      pi.appendEntry("decision-error", { turn: currentTurn, reason: "redaction", status: "not_evaluated" });
      if (ctx.mode === "print") console.log(`Decision feedback — turn ${currentTurn}\nStatus: not evaluated (redaction). No evidence was sent.`);
      return;
    }
    last = captured;
    try {
      if (!scoringClient) throw new Error(configurationError ?? "Decision client is not configured.");
      captured.report = await scoringClient.evaluate(captured.evidence, currentTurn, signal);
      if (signal.aborted) return;
      pi.appendEntry("decision-report", { ...captured.report, verbose: settings.verbose });
      if (!captured.report.flagged.length) {
        if (ctx.mode === "print" && settings.verbose) console.log(formatReport(captured.report, true));
        return;
      }
      if (ctx.mode === "print") console.log(formatReport(captured.report, settings.verbose));
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof DecisionError ? error.code : "configuration";
      pi.appendEntry("decision-error", { turn: currentTurn, reason, status: "not_evaluated" });
      if (ctx.mode === "print") console.log(`Decision feedback — turn ${currentTurn}\nStatus: not evaluated (${reason}). No pass was recorded. The escalation reviewer checks this turn without a decision score.`);
    }
    void startReview(captured, ctx, true);
  });

  pi.registerCommand("decision", {
    description: "Decision controls: on, off, status, settings, review, or verbose [on|off]",
    handler: async (args, ctx) => {
      try {
        let action = args.trim();
        const preferences = { projectTrusted: ctx.isProjectTrusted() };
        if (!action) {
          if (!ctx.hasUI) { console.log("Use /decision on, off, status, settings, review or verbose [on|off]."); return; }
          const choice = await ctx.ui.select(`Decision advisor — automatic review ${configuration?.enabled ? "on" : "off"}`, ["on", "off", "status", "settings"]);
          if (!choice) return;
          action = choice;
        }
        if (["verbose", "verbose on", "verbose off", "on", "off"].includes(action)) {
          const current = configuration ?? await loadDecisionSettings(ctx.cwd, preferences);
          const changed = action.startsWith("verbose") ? "verbose" : "enabled";
          const requested = changed === "enabled" ? action === "on" : action === "verbose" ? !current.verbose : action === "verbose on";
          const saved = await saveDecisionSettings(ctx.cwd, { ...current, [changed]: requested }, preferences);
          redactor ??= await createSecretRedactor(ctx);
          applySettings(saved);
          const text = `Decision ${changed === "enabled" ? "automatic review" : "verbose output"} is ${saved[changed] ? "on" : "off"}.${saved[changed] !== requested ? " A trusted project override takes precedence." : ""}`;
          if (ctx.hasUI) ctx.ui.notify(text, saved[changed] !== requested ? "warning" : "info");
          else console.log(ctx.mode === "json" ? JSON.stringify({ type: "decision_settings", [changed]: saved[changed] }) : text);
          return;
        }
        if (action === "settings") {
          const saved = await configureDecision(ctx);
          if (saved) { redactor = await createSecretRedactor(ctx); applySettings(saved); }
          return;
        }
        if (action === "status") {
          await showDecisionStatus(ctx, configuration ?? await loadDecisionSettings(ctx.cwd, preferences), last, controller.signal);
          return;
        }
        if (action !== "review") { ctx.ui.notify("Use /decision on, off, status, settings, review or verbose [on|off].", "warning"); return; }
        if (!last) { ctx.ui.notify("No turn evidence captured in this session yet.", "warning"); return; }
        const captured = last;
        if (captured.review) {
          await captured.review;
          if (!captured.result) ctx.ui.notify("The escalation review did not complete. Inspect /decision settings.", "warning");
          else if (ctx.hasUI) ctx.ui.notify(`Review for turn ${captured.turn} is already in the transcript.`, "info");
          else console.log(formatReview(captured.result, captured.turn));
        } else await startReview(captured, ctx, false);
      } catch {
        const text = "Decision command failed. Check /decision settings and preference file permissions. No configuration success was recorded.";
        if (ctx.hasUI) ctx.ui.notify(text, "error"); else console.error(text);
      }
    },
  });
}
