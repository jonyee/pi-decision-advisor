import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AzureDecisionClient, CurrentEvidenceOverflowError, DecisionError, packEvidence } from "./decision.ts";
import { REVIEW_HOST_WAIT_MS, toDecisionOptions, type DecisionSettings } from "./config.ts";
import { buildEvidence } from "./evidence.ts";
import { reviewTurn, ReviewerError, ReviewerConfigurationError, waitForReviews, type ReviewerErrorCode } from "./review.ts";
import { type DecisionReport, type ReviewResult, type TurnEvidence } from "./types.ts";
import { loadDecisionSettings, saveDecisionSettings } from "./settings.ts";
import { configureDecision } from "./settings-ui.ts";
import { showDecisionStatus } from "./status-ui.ts";
import { ReviewHistory } from "./review-history.ts";
import { createSecretRedactor, type SecretRedactor } from "./secrets.ts";
import { findingSummary, formatReview, numberReviewFindings } from "./review-feedback.ts";

interface ReviewedTurn {
  evidence: TurnEvidence;
  report?: DecisionReport;
  turn: number;
  assistantEntryId: string;
  settings: DecisionSettings;
  review?: Promise<void>;
  result?: ReviewResult;
  error?: { category: ReviewerErrorCode; detail: string };
}

function reviewColor(result: ReviewResult): "success" | "warning" | "error" {
  if (result.findings.some(finding => finding.severity === "blocker")) return "error";
  return result.verdict === "accept" ? "success" : "warning";
}

function feedbackComponent(text: string, theme: Theme, color: "success" | "warning" | "error"): Container {
  const [heading, ...lines] = text.split("\n");
  const component = new Container();
  component.addChild(new Text(theme.fg(color, theme.bold(heading)), 1, 0));
  if (lines.length) component.addChild(new Text(theme.fg("customMessageText", lines.join("\n")), 1, 0));
  return component;
}

export default function decisionAdvisor(pi: ExtensionAPI, options: { reviewWaitMs?: number } = {}) {
  const reviewWaitMs = options.reviewWaitMs ?? REVIEW_HOST_WAIT_MS;
  if (!Number.isInteger(reviewWaitMs) || reviewWaitMs < 0 || reviewWaitMs > REVIEW_HOST_WAIT_MS) throw new ReviewerConfigurationError(`Host review wait must be between 0 and ${REVIEW_HOST_WAIT_MS} milliseconds.`);
  let controller = new AbortController();
  let reviewerController = new AbortController();
  let redactor: SecretRedactor | undefined;
  let client: AzureDecisionClient | undefined;
  let configurationError: string | undefined;
  let configuration: DecisionSettings | undefined;
  let last: ReviewedTurn | undefined;
  const reviews = new Set<Promise<void>>();
  const reviewHistory = new ReviewHistory();
  let turn = 0;
  let primaryCancellation: (() => void) | undefined;
  let reviewStatusUI: ExtensionContext["ui"] | undefined;
  let reviewWorkingUI: ExtensionContext["ui"] | undefined;
  let reviewWorkingHidden = false;

  const restoreReviewWorking = () => {
    const ui = reviewWorkingUI;
    reviewWorkingUI = undefined;
    if (!ui) return;
    if (!reviewWorkingHidden) ui.setWorkingVisible(false);
    reviewWorkingHidden = false;
    // Visibility is persistent: restore it for the next primary run. At settled,
    // Pi is no longer streaming, so this does not recreate the loader.
    ui.setWorkingVisible(true);
  };
  // A dedicated footer status survives agent_end and the bounded settlement wait.
  // The shared Working row can only cover the active pre-settlement wait.
  const updateReviewStatus = (ctx?: ExtensionContext) => {
    if (ctx?.mode === "tui") reviewStatusUI = ctx.ui;
    reviewStatusUI?.setStatus("decision-review-activity", reviews.size === 0 ? undefined
      : reviews.size === 1 ? "Reviewing…" : `Reviewing… (${reviews.size} pending)`);
  };
  const cancelReviews = () => {
    reviewerController.abort();
    reviewerController = new AbortController();
    reviews.clear();
    updateReviewStatus();
  };
  const watchPrimaryCancellation = (signal: AbortSignal | undefined) => {
    primaryCancellation?.();
    primaryCancellation = undefined;
    if (!signal) return;
    if (signal.aborted) { cancelReviews(); return; }
    signal.addEventListener("abort", cancelReviews, { once: true });
    primaryCancellation = () => signal.removeEventListener("abort", cancelReviews);
  };
  const reset = () => {
    primaryCancellation?.();
    primaryCancellation = undefined;
    cancelReviews();
    if (reviewWorkingUI && !reviewWorkingHidden) {
      reviewWorkingUI.setWorkingVisible(false);
      reviewWorkingHidden = true;
    }
    reviewStatusUI = undefined;
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
  const showError = (text: string, ctx: ExtensionContext, data: { turn: number; automatic: boolean; category: ReviewerErrorCode }) => {
    pi.appendEntry("decision-review-error", { ...data, text });
    if (ctx.mode === "print") console.log(text);
  };
  const displayReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean) => {
    if (!captured.result) return;
    const content = formatReview(captured.result, captured.turn);
    pi.appendEntry("decision-review", { turn: captured.turn, assistantEntryId: captured.assistantEntryId, automatic, result: captured.result, content });
    if (ctx.mode === "print") console.log(content);
  };

  // Automatic triage is silent, including failures and saved verbose preferences.
  // Keep durable diagnostics for session/JSON consumers and explicit /decision status.
  // Register hidden renderers so resumed score/error entries also stay invisible.
  pi.registerEntryRenderer("decision-report", () => undefined);
  pi.registerEntryRenderer("decision-error", () => undefined);
  pi.registerEntryRenderer<{ text: string }>("decision-review-error", (entry, _options, theme) => entry.data ? feedbackComponent(entry.data.text, theme, "error") : undefined);
  pi.registerEntryRenderer<{ turn: number; result: ReviewResult }>("decision-review", (entry, { expanded }, theme) => {
    if (!entry.data) return undefined;
    const { result, turn: reviewedTurn } = entry.data;
    const component = new Container();
    const color = reviewColor(result);
    if (!result.findings.length) return feedbackComponent(formatReview(result, reviewedTurn), theme, color);
    component.addChild(new Text(theme.fg(color, theme.bold(`Advisor review (${reviewedTurn})`)), 1, 0));
    for (const finding of expanded ? result.findings : result.findings.slice(0, 3)) {
      const summary = theme.fg(finding.severity === "blocker" ? "error" : "warning", findingSummary(finding));
      component.addChild(new Text(`${summary}\n${theme.fg("dim", `Evidence: ${finding.evidence}`)}\nRecommendation: ${finding.recommendation}`, 1, 1));
    }
    if (!expanded && result.findings.length > 3) component.addChild(new Text(theme.fg("dim", `${result.findings.length - 3} more findings — expand transcript details to view.`), 1, 0));
    return component;
  });

  const startReview = (captured: ReviewedTurn, ctx: ExtensionContext, automatic: boolean): Promise<void> => {
    if (captured.review) return captured.review;
    const generation = controller.signal;
    const signal = AbortSignal.any([generation, reviewerController.signal]);
    const reviewRedactor = redactor;
    const job = (async () => {
      delete captured.error;
      try {
        if (!reviewRedactor) throw new ReviewerConfigurationError("Secret protection is unavailable. Reload the extension before requesting a review.");
        const result = await reviewTurn(ctx, captured.evidence, captured.report, signal, {
          model: captured.settings.reviewModel,
          timeoutMs: captured.settings.advisorTimeoutMs,
          tools: captured.settings.reviewTools,
          instructions: captured.settings.reviewInstructions,
          history: reviewHistory.snapshot(captured.turn, captured.settings.reviewHistoryTurns),
        }, reviewRedactor);
        if (signal.aborted) return;
        captured.result = numberReviewFindings(result, captured.turn);
        reviewHistory.record({ turn: captured.turn, userRequest: captured.evidence.userRequest, result: captured.result }, captured.settings.reviewHistoryTurns);
        displayReview(captured, ctx, automatic);
      } catch (error) {
        if (signal.aborted) { captured.review = undefined; return; }
        const failure = error instanceof ReviewerError ? error : new ReviewerError("provider");
        const detail = reviewRedactor?.redactText(failure.message) ?? "Reload the extension before requesting a review.";
        captured.error = { category: failure.code, detail };
        showError(`Advisor review (${captured.turn}): Failed (${failure.code}). No reviewer findings were applied. ${detail.replace(/\s*\r?\n\s*/g, " ")}`,  ctx, { turn: captured.turn, automatic, category: failure.code });
      }
    })();
    captured.review = job;
    reviews.add(job);
    updateReviewStatus(ctx);
    void job.finally(() => {
      // Cancelled/reset generations must not clear a newer review's status.
      if (reviews.delete(job)) updateReviewStatus();
    }).catch(() => {});
    return job;
  };

  const initializeSettings = async (ctx: ExtensionContext) => {
    reset();
    configuration = undefined;
    client = undefined;
    redactor = undefined;
    configurationError = undefined;
    const generation = controller.signal;
    try {
      const settings = await loadDecisionSettings(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
      const nextRedactor = await createSecretRedactor(ctx);
      if (generation.aborted) return;
      redactor = nextRedactor;
      applySettings(settings);
    } catch { configurationError = "Decision settings or secret protection could not be loaded. Open /decision settings to configure them."; }
    // Configuration failures are triage diagnostics; reviewer feedback remains visible.
  };
  pi.on("session_start", (_event, ctx) => initializeSettings(ctx));
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_start", (_event, ctx) => {
    // A queued continuation owns the loader again; do not hide its Working row.
    reviewWorkingUI?.setWorkingVisible(true);
    reviewWorkingUI = undefined;
    reviewWorkingHidden = false;
    watchPrimaryCancellation(ctx.signal);
  });
  pi.on("agent_settled", restoreReviewWorking);
  pi.on("agent_end", (event, ctx) => {
    const final = event.messages.findLast(message => message.role === "assistant");
    if (ctx.signal?.aborted || (final?.role === "assistant" && final.stopReason === "aborted")) cancelReviews();
    // The run signal is only a user-cancellation source while that primary run is active.
    primaryCancellation?.();
    primaryCancellation = undefined;
  });
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
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome === "aborted") { cancelReviews(); return; }
    if (ctx.mode === "tui" && reviews.size > 0 && reviewWaitMs > 0) {
      // agent_end removed the native loader, but Pi is still streaming until
      // agent_settled. Re-show it without changing its message or animation.
      reviewWorkingUI = ctx.ui;
      reviewWorkingHidden = false;
      ctx.ui.setWorkingVisible(true);
    }
    await waitForReviews(reviews, controller.signal, reviewWaitMs);
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.outcome === "aborted") { cancelReviews(); return; }
    if (!configuration?.enabled) return;
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
      return;
    }
    last = captured;
    try {
      captured.evidence = packEvidence(captured.evidence).evidence;
      if (!scoringClient) throw new Error(configurationError ?? "Decision client is not configured.");
      captured.report = await scoringClient.evaluate(captured.evidence, currentTurn, signal);
      if (signal.aborted) return;
      pi.appendEntry("decision-report", { ...captured.report, verbose: settings.verbose });
      if (!captured.report.flagged.length) return;
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof DecisionError ? error.code : "configuration";
      const detail = error instanceof CurrentEvidenceOverflowError
        ? `Current evidence alone uses ${error.currentTokens} tokens, above the ${error.maxTokens}-token budget; it was not truncated. The reviewer receives the original redacted evidence.` : undefined;
      pi.appendEntry("decision-error", { turn: currentTurn, reason, detail, status: "not_evaluated" });
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
        if (captured.error) captured.review = undefined;
        if (captured.review) {
          await waitForReviews([captured.review], controller.signal, reviewWaitMs);
          if (!captured.result) ctx.ui.notify(captured.error ? `Review ${captured.error.category}: ${captured.error.detail}` : "The escalation review is still running. Its findings will be saved for the next request.", captured.error ? "warning" : "info");
          else if (ctx.hasUI) ctx.ui.notify(`Review for turn ${captured.turn} is already in the transcript.`, "info");
          else console.log(formatReview(captured.result, captured.turn));
        } else await waitForReviews([startReview(captured, ctx, false)], controller.signal, reviewWaitMs);
      } catch {
        const text = "Decision command failed. Check /decision settings and preference file permissions. No configuration success was recorded.";
        if (ctx.hasUI) ctx.ui.notify(text, "error"); else console.error(text);
      }
    },
  });
}
