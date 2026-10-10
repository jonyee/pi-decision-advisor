import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";

/** Keep focus off the main editor until an explicitly requested operation settles. */
export async function withLoading<T>(ctx: ExtensionCommandContext, message: string, run: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T | undefined> {
  if (outerSignal?.aborted) return undefined;
  // RPC supports native dialogs, but not custom terminal components.
  if (ctx.mode !== "tui") {
    const signal = outerSignal ?? new AbortController().signal;
    try {
      const value = await run(signal);
      return signal.aborted ? undefined : value;
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    }
  }
  type Result = { kind: "ready"; value: T } | { kind: "error"; error: unknown } | { kind: "cancelled" };
  const result = await ctx.ui.custom<Result>((tui, theme, _keys, done) => {
    const request = new AbortController();
    let settled = false;
    const finish = (value: Result) => {
      if (settled) return;
      settled = true;
      outerSignal?.removeEventListener("abort", cancel);
      loader.stop();
      done(value);
    };
    const cancel = () => {
      request.abort();
      finish({ kind: "cancelled" });
    };
    const loader = new (class extends CancellableLoader {
      override dispose() {
        request.abort();
        outerSignal?.removeEventListener("abort", cancel);
        super.dispose();
      }
    })(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), `${message} (Esc cancels)`);
    loader.onAbort = cancel;
    outerSignal?.addEventListener("abort", cancel, { once: true });
    const signal = AbortSignal.any([request.signal, loader.signal, ...(outerSignal ? [outerSignal] : [])]);
    void Promise.resolve().then(() => {
      if (signal.aborted) { cancel(); return; }
      return run(signal).then(
        value => finish(signal.aborted ? { kind: "cancelled" } : { kind: "ready", value }),
        error => finish(signal.aborted ? { kind: "cancelled" } : { kind: "error", error }),
      );
    }).catch(error => finish(signal.aborted ? { kind: "cancelled" } : { kind: "error", error }));
    return loader;
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "ready" ? result.value : undefined;
}
