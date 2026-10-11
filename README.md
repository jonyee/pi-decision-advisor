# Pi Decision advisor

Microsoft-Decision-1 on Azure Foundry reviews every completed **primary model turn**, including tool-loop turns. Passing turns are silent. Failed or unassessed turns automatically start a separately configured tool-capable reviewer. Findings are advisory context for the primary's next natural request; feedback never requests another primary turn.

This is a **stock pi.dev extension**, using `@earendil-works/pi-*`. No OMP fork or native advisor subsystem is required. The Azure deployment utilities remain in this repository.

## Install

Requires **Pi 0.99.2 or newer** and Node **22.19+**. Development dependencies and runtime verification target stock Pi 0.99.2; Pi 1.1.0 exposes the same required APIs.

```sh
pi install git:github.com/jonyee/pi-decision-advisor
```

The Pi extension lives in `jonyee/pi-decision-advisor`; the OMP implementation has a separate repository, `jonyee/omp-decision-advisor`. For a checkout:

```sh
npm ci --ignore-scripts
pi install /path/to/pi-decision-advisor
```

Restart Pi or reload extensions after installation. Remove with `pi remove <installed-source>`.

Pi supplies the agent, model and TUI packages; they are peers, not bundled runtime copies. External runtime dependencies are Azure Identity and `@huggingface/tokenizers`. The archive includes `src/`, the manifest and this README, including the pinned compressed Qwen3.5 tokenizer and its Apache-2.0 license. Tokenization is offline; no model weights or runtime tokenizer downloads are required. TypeScript loads directly without an extension build. `private: true` prevents npm-registry publication; Git installation still works. The extension itself has no selected redistribution license.

For a tarball, first install it with npm into a private directory, then `pi install` that package directory:

```sh
npm pack --ignore-scripts
npm install --ignore-scripts --omit=dev --legacy-peer-deps \
  --prefix "$HOME/.local/share/pi-decision-extensions" \
  /path/to/pi-decision-advisor-0.7.0.tgz
pi install "$HOME/.local/share/pi-decision-extensions/node_modules/pi-decision-advisor"
```

## Configure

Run `/decision` for **on**, **off**, **status**, and **settings**. Select both an existing Azure scoring deployment and an authenticated Pi reviewer model. The reviewer starts unconfigured: there is no implicit primary-model fallback and no `@advisor` alias.

| Preference | Contract |
|---|---|
| Automatic review | On by default; off cancels outstanding extension work and disables automatic scoring/review |
| Scoring model | Healthy existing Microsoft-Decision-1 Azure deployment, or manual account HTTPS origin and deployment name |
| Reviewer model | Explicit available Pi `provider/model` ID; blank means unconfigured |
| Tools | Initially `read,grep,find`; blank grants none |
| Instructions | Multiline reviewer preferences, at most 8192 UTF-8 bytes; never enter credentials |
| Review history entries | At most 3 completed prior summaries by default; integer 0–8; 0 disables |
| Azure credentials | Azure CLI identity (`az login`) or `DefaultAzureCredential` |
| Pass threshold | Initially 0.8; range 0.5–1; lower means fewer escalations |
| Scoring timeout | Initially 10000 ms; range 100–20000 ms, covering authentication and inference |
| Reviewer timeout | Initially 60000 ms; range 100–120000 ms, including tool approvals; independent of the host's bounded wait |
| Verbose output | Off by default; shows passing scores and full sanitized Decision reports, not reviewer JSON |

**Save** persists validated user preferences and applies effective values immediately. **Cancel** discards the draft. Settings changes clear latest-turn capture and in-memory review history and cancel old-configuration work.

User preferences live at `getAgentDir()/decision-advisor.json`, normally `~/.pi/agent/decision-advisor.json`. `PI_CODING_AGENT_DIR` selects a different Pi agent directory. Writes use an atomic replacement and mode 0600 on POSIX. `.pi/decision-advisor.json` project overrides are read only when Pi reports the project trusted. They are never edited by the menu; Save warns when they shadow user values. External file edits apply on the next session/reload.

No OMP plugin settings or custom `DECISION_*` variables are read. Existing OMP preferences are not automatically imported. Copy only desired non-secret settings, replace `@advisor` with an explicit Pi model ID and `glob` with `find`, and remove unsupported OMP grants.

### Reviewer tools and approval

Supported stock tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, plus `powershell` on Windows. `grep` requires `rg`; `find` requires `fd` or `fdfind`. Missing requested prerequisites fail **before inference**, without downloading tools or silently dropping grants. OMP-only tools such as `recall`, `lsp`, `web_search`, `eval`, `ast_edit` and `debug` are not aliases or inherited integrations.

The reviewer is a separate in-memory Pi Agent with only the selected tools and explicit prompt. It discovers no ambient extensions, MCP, skills, rules or subagents. Its model calls use `ctx.modelRegistry.streamSimple()`, preserving Pi's configured provider credentials and headers.

Elevated grants require confirmation in the picker and a warning at Save. **Every actual `bash`, `powershell`, `edit` or `write` operation also requires fresh TUI/RPC confirmation.** Headless execution is denied. A denied or failed tool prevents the reviewer from reporting a successful review. Pi does not inherit OMP approval settings; this extension owns the reviewer approval gate.

Tool grants are **not a sandbox**. Approved tools run with the Pi process's permissions and can affect files, processes or external resources. Cancellation fences late approvals and pending file commits and kills running shell process groups; it cannot undo completed actions or guarantee control over intentionally detached/external work.

### Secret protection

Before Decision inference, conversation evidence is irreversibly redacted. Reviewer requests, fresh tool content/details/structured results, provider output, findings and retained summaries are redacted too; placeholders are never restored.

Initialization reads only local sensitive environment values, literal configured credentials/headers and stored Pi access/refresh/key values. It does not refresh authentication, execute configured credential commands, log in or contact providers. Pattern detection covers common vendor credentials, private keys, authorization headers, credential assignments, URL passwords and signed-URL secrets.

This is best-effort redaction, **not proof that arbitrary secrets can never escape**. Unknown credentials without recognizable context can remain undetected. Evidence intentionally includes conversation text, instructions and tool results; do not enable cloud scoring for material that must never leave the machine.

### Azure discovery and authentication

Deployment discovery is explicitly requested and read-only. In the TUI, its loading modal owns input focus; Escape cancels the subprocess, and late results cannot reopen a picker. RPC uses native dialogs and direct bounded operations, not custom terminal components. Without cloud discovery permission, enter the existing account HTTPS origin and deployment manually. Do not append `/providers/microsoft/v1/systemone`; the client adds it.

Azure CLI authentication uses the signed-in `az login` identity. DefaultAzureCredential supports standard Azure SDK managed/workload/environment identity mechanisms. Inference still requires existing data-plane permissions and network access. The extension never grants roles or changes Azure security/network policy. Azure API-key authentication is not supported by this System One client; tokens and API keys are never saved in preferences.

### Commands

- `/decision` — four-action control menu.
- `/decision on` / `/decision off` — persist automatic review state. Explicit diagnostics remain available while off.
- `/decision settings` — deployment, reviewer, tool grants, instructions, history and triage preferences.
- `/decision status` — configuration, latest scores and **one batched synthetic matching/mismatching arithmetic smoke request** when configured. No conversation history or reviewer invocation. Wrong classification fails; auth/network/malformed responses are errors. TUI-cancellable; available while off.
- `/decision review` — reuse the captured automatic review, or explicitly review a captured passing turn. Reuse does not duplicate model calls or transcript entries.
- `/decision verbose [on|off]` — toggle/set saved verbose output.

A turn is captured only when automatic scoring is enabled. Status remains available without a captured turn.

## Failure policy and scheduling

All five independent rubric questions—adherence, groundedness, correctness, safety and progress—are sent in **one Azure System One request per primary assistant turn**:

```text
POST {endpoint}/providers/microsoft/v1/systemone
Authorization: Bearer <Azure Identity token>
{ model: deployment, state: serializedEvidence, questions: fiveRubrics }
```

This is direct classification, not a chat-completions provider. A turn fails triage if any verdict is `concern`, `blocker` or `cannot_tell`, or `P(pass)` is below the configured threshold. Equality passes. The starting 0.8 threshold is not a calibrated correctness guarantee. Scoring failures remain **not evaluated**, and invoke review without a score; reviewer failures never become accepts. If secret protection fails, no raw evidence is sent.

Scoring is awaited in Pi's `turn_end`. Reviewer work can overlap later primary tool-loop turns. At `agent_before_settle`, the extension waits at most 20000 ms for outstanding reviews; exhausting this wait does not cancel their execution. A reviewer has its own execution deadline, initially 60000 ms and configurable up to 120000 ms. Existing saved shorter reviewer timeouts remain unchanged. A late completed review is persisted for the next natural request without restarting the primary. Settings changes, off, session changes and shutdown cancel extension-owned work. Aborted primary turns also cancel their reviews. Stock Pi 0.99.2 exposes no public cancellation event for Escape after the primary loop has already stopped during pre-settlement; that action cannot reliably cancel a detached reviewer. The extension never sets `continue: true`, steers the primary, changes its model, approves primary actions or invokes a native watchdog.

Reviews may accept first-stage flags that investigation does not confirm. Tool-enabled reviews can make multiple chat-model requests; passing turns make no reviewer requests. The owner reports an endpoint allowance of 17 requests/second. The extension does not change quota, deployment capacity or rate limits.

History contains only completed earlier-turn summaries, sorted by primary turn, capped at the configured count and **16384 serialized UTF-8 bytes**. Oversized/old entries are omitted whole, not truncated. Concurrent reviews never see unfinished summaries. Settings changes, on/off, branching, compaction, session changes and shutdown clear this in-memory reviewer history.

## Transcript and output

Scores, scoring errors and review results are durable **Pi custom session entries** with extension-owned renderers. Passing score entries render nothing unless verbose. Failed scores appear before reviewer notes and stay visible during delayed review; no temporary widget replaces them. Findings carry severity, evidence and recommendation. Collapsed reviews show three findings; **Ctrl+O** expands the remainder. Empty accepted/uncertain reviews display explicit notices.

Scores/errors never enter model context. Persisted reviews are projected as advisory custom context on later natural requests only while their source assistant entry remains in the current projected context. Branching, compaction or context edits do not resurrect omitted source turns. The canonical primary transcript still ends in its answer, preserving stock Pi's print behavior.

In **text print mode**, the primary answer remains on stdout; Pi routes extension score/review/status diagnostics to stderr. In **JSON mode**, standard `entry_appended` events retain full structured Decision reports and review results regardless of verbose presentation. No private Pi stdout APIs or patched native advisor events are used.

Evidence includes the current standing prompt, latest user request, current assistant output and tool results. Those current fields remain intact. The latest user message and current assistant/tool-result copies are excluded from historical context; older context is packed newest-first into complete messages within a **28000-token** serialized-evidence allowance, then presented chronologically. Token counting uses the bundled offline Qwen3.5-9B tokenizer, leaving 4768 tokens within Decision-1's published 32768-token context for rubric, choices and service framing. The service's internal formatting is not exposed, so near-ceiling Azure acceptance is not guaranteed. If current evidence alone exceeds the allowance, the extension reports that separately with token counts and sends no scoring request; the original current evidence remains available for independent review. Evidence is never silently truncated. Attachments are explicitly unavailable to the text-only judge. Review is post-turn and cannot prevent a tool action already executed.

Reviewer failures expose sanitized categories: `timeout`, `cancelled`, `configuration`, `provider`, `tool`, or `response`. A timeout reports the reviewer deadline rather than suggesting credentials. Provider errors do not print upstream bodies, tokens or private endpoint details; configuration and response failures never become accepted reviews.

## Checkout utilities and deployment

The launcher, probe and Azure deployment CLI are checkout-only utilities, excluded from the extension archive.

```sh
npm ci --ignore-scripts
npm run pi -- --version
npm run pi
npm run probe -- --cwd /path/to/workspace --agent-dir /path/to/pi-agent
# Add --trust-project only to include a reviewed .pi/decision-advisor.json override.
```

Run the launcher from the intended workspace using an absolute path to `scripts/pi.ts` when necessary; Pi does not support OMP's `--cwd` or `--profile` flags. The launcher explicitly loads this extension and disables discovery, avoiding an installed duplicate. Explicit additional `-e` paths still work. Use ordinary `pi` for the normal extension roster.

The probe reads the same extension-owned preferences, sends public synthetic correct arithmetic versus wrong arithmetic/fabricated tests, prints sanitized judgments and exits nonzero unless discrimination is demonstrated. It is not general quality calibration.

Deployment tooling reuses existing healthy `AIServices` accounts and queries live model catalog/quota:

```sh
npm run deploy -- list
npm run deploy -- plan --location eastus2 --sku DataZoneStandard --capacity 17
npm run deploy -- apply --location eastus2 --sku DataZoneStandard --capacity 17
```

It creates only the requested Microsoft-Decision-1 deployment or reuses an exact healthy match. It never creates accounts/resource groups, grants permissions, changes authentication/network settings or deploys the reviewer model. Conflicting existing version/SKU/capacity is rejected, not overwritten. Azure's create API is create-or-update; do not deploy the same name concurrently. `list --show-identifiers` reveals resource names only explicitly. The existing default deployment name `omp-decision-1` is retained to avoid renaming cloud resources during this host cutover; select the actual existing deployment in `/decision settings`.

DataZoneStandard limits processing to a data zone, not one region. It is pay-as-you-go, not reserved throughput. Microsoft's introduction lists $0.042 per million input tokens; verify current pricing and quota before deployment. Reviewer charges depend on the selected Pi provider.

## Verification

```sh
npm run check
npm test
npm run probe
```

Stock Pi 0.99.2 CLI smokes used a local TLS System One fixture with the real Azure Identity CLI path and deterministic chat providers. They exercised batched tool-loop scoring, selected-tool file reads, evidence/tool-result redaction, scores-before-notes, findings in the next natural prompt, silent passing output, accepted-review print output, headless mutation denial and status smoke while off. Two prompts with a primary file-read loop produced three primary calls, with no feedback-triggered calls.

Actual Pi TUI verification covered the four-action menu, preference cancellation, retained scores, three-finding collapse, Ctrl+O expansion, status smoke, focused loading cancellation, blocked main-editor input during loading and persisted off state. Actual RPC verification covered approved mutation, denial, review timeout, abort and late approval fencing. TypeScript checking and all 159 behavioral tests pass. These are local deterministic checks, **not live Azure inference or reviewer-quality calibration**.

Correction smokes exercised actual Pi 0.99.2 sessions: a 21.5-second reviewer outlived the default 20-second settlement wait, persisted its finding afterward, and supplied it to the next natural request without an extra primary call. A stalled reviewer produced the durable `timeout` category; current-only overflow produced `evidence_current_overflow` with zero scoring calls. Actual TUI output retained score lines before the timeout notice and showed execution-deadline guidance instead of generic credential advice. These checks used synthetic providers and made no live Azure inference requests.

Replaying the supplied 36-turn export through deduplication and historical packing admitted 35 turns without changing current evidence; one current-only payload still exceeded the allowance. No scoring requests were made. Token-counter comparisons covered Unicode/NFC, JSON, special tokens and cached/capped counting against the full pinned tokenizer.

## Changes

### 0.7.0

- Clean cutover to stock Pi packages, lifecycle boundaries and extension-owned transcript rendering; no OMP host fork.
- Extension-owned private preferences with trusted read-only project overrides and explicit reviewer model IDs.
- Isolated selected-tool reviewer, per-operation elevated approval, fail-closed headless execution and one-way secret redaction.
- Pi launcher/probe configuration and behavioral regression coverage for host integration, cancellation, approvals and persistence.
- Moved the Pi port and subsequent integration fixes to `jonyee/pi-decision-advisor`, preserving the original repository history.
- Offline 28000-token evidence allowance with current-turn deduplication, newest-first historical packing and explicit current-only overflow reporting.
- Independent reviewer execution deadline (60000 ms default, up to 120000 ms), bounded 20000 ms settlement wait and sanitized failure categories.

## Sources

- [Microsoft model specification](https://ai.azure.com/catalog/models/Microsoft-Decision-1)
- [Foundry System One introduction and pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-microsoft-decision-1-in-microsoft-foundry-for-decision-and-classific/4562742)
- [Azure deployment CLI](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/deployment)
- [Pi extensions](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/packages.md)
