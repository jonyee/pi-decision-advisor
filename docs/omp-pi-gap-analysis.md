# OMP → Pi: local extension and functionality gap analysis

## Scope and confidence

Snapshot: this host, from `/home/nixos/git/omp-decision-advisor`, during Pi session `01a1289e-e253-7124-9ed7-9f52c744abec` (session file dated 2026-10-11).

This compares the installed OMP fork, its local source/configuration, stock Pi 0.99.2, and the extensions actually configured on this host. It is **not** a comparison with old pi-mono or a claim about all extensions available in the ecosystem.

Evidence levels:

- **Observed:** installed paths, configuration, command output, current model tool surface, offline RPC startup inventory, and local tests.
- **Source-supported:** installed documentation/code or the local OMP checkout describes a capability; a real workflow was not necessarily exercised.
- **Unverified:** cloud credentials, inference quality, live MCP integrations, IDE/browser/desktop execution, and full TUI parity.

No packages were installed, preferences changed, Azure resources modified, or live scoring/search requests made for this audit. RPC inventories used `PI_OFFLINE=1`, `--no-session`, and no model prompts. Existing uncommitted migration changes were left intact.

## Executive assessment

Pi currently covers ordinary coding, sessions/branching, extensibility, web research, rich editor/footer convenience, and the Decision-1 escalation workflow. It does **not** reproduce OMP's integrated IDE, multi-agent, memory, debugger, internal filesystem, or editor-protocol stack.

The biggest practical gaps are:

1. No installed Pi subagent/task orchestration or Agent Hub equivalent.
2. No installed Pi LSP integration or automatic diagnostics on writes.
3. No Pi counterpart to the installed Herdr agent-state integration.
4. Decision review has deliberately different delivery/history semantics and lacks OMP's advisor usage ledger and full investigative transcript.
5. Configuration and launch paths are split: Nix-loaded extensions are absent from `pi list`, and the development launcher does not isolate them on this host.
6. MCP is installed but currently has **zero configured servers** in the adapter; native and adapter MCP coexist with different configuration/control surfaces.

Several apparent losses are only latent capabilities: OMP's native advisor and memory default to off, and the Decision extension is currently off in Pi. Do not equate “OMP supports it” with “it was active here.”

## 1. Installed and enabled inventory

### Host versions and ownership

| Component | Observed version/source | Ownership |
|---|---|---|
| Pi host | `pi --version` → `0.99.2` | Nix-installed `@earendil-works/pi-coding-agent`; shell wrapper adds extensions |
| OMP host | Nix derivation `oh-my-pi-18.8.9-fork.2`; binary reports `omp/18.8.9` | Fork release `fork-v18.8.9-2` in `nix-config/oh-my-pi.nix` |
| OMP source baseline | Local `oh-my-pi` checkout, packages at 18.8.9 | Source inspection; exact correspondence to the compiled binary was not proven |
| Pi Decision advisor | `pi-decision-advisor@0.7.0` | Mutable local checkout, declared in user Pi settings |

The user Pi settings contain only `../../git/omp-decision-advisor` as a package. Normal Pi startup additionally gets three explicit `--extension` arguments from its Nix wrapper.

### Pi extension roster

| Extension | Version | Actual load state and functionality | Caveat |
|---|---|---|---|
| `pi-mcp-adapter` | 4.0.0 | RPC registration confirmed: `/mcp-adapter`, `/mcp-auth`; current session exposes `mcp` gateway | Current gateway status: `MCP: 0/0 servers, 0 tools`. Installing the adapter does not provision integrations |
| `pi-powerline-footer` | 0.19.0 | RPC registration confirmed: `/cd`, `/reply`, `/queue`, `/powerline`, `/stash-history`, `/bash-mode`, `/bash-reset`, `/powerline-perf`, `/vibe` | More than a cosmetic footer: owns editor wrapping, prompt queueing, managed user shell and optional nested model calls |
| `pi-web-access` | 0.35.0 | RPC registration confirmed: `/websearch`, `/curator`, `/search`, `/google-account`; current model sees `web_enable` | Search/fetch tools are dynamically activated. No live provider test in this audit |
| Local Decision advisor | 0.7.0 | `/decision` confirmed; user preferences configure Azure CLI scoring and explicit Copilot reviewer with `read,grep,find` | `enabled: false`: loaded but automatic scoring/review is disabled |
| Stock built-ins | Host 0.99.2 | Normal RPC inventory includes `/mcp` from `builtin:mcp` and `/llama` from `builtin:llama.cpp`; codemode/tool-search are available built-in extensions | Availability does not mean their tools are active. Current model surface does not expose `codemode` or `tool_search` |

No user-local Pi extension/skill/prompt directories or project `.pi` configuration were found in this workspace. `nix-config/.pi/settings.json` separately has `packages: []`; it does not negate wrapper-provided explicit extensions.

Current primary model: `github-copilot/gpt-6.1-sol`. Current visible tools: `read`, `bash`, `edit`, `write`, `mcp`, and `web_enable` (plus the harness's parallel-call wrapper). Stock `grep`, `find`, and `ls` exist but are not in this primary selection; shell commands provide search/listing instead.

### OMP extension roster and active preferences

| Item | Observed state | Implication |
|---|---|---|
| Herdr integration | `~/.omp/agent/extensions/herdr-omp-agent-state.ts`, integration version 10 | Reports session association and working/blocked/idle states to Herdr; requires Herdr environment and root interactive session |
| Legacy Decision plugin declaration | `~/.omp/plugins/package.json` retains `omp-decision-advisor`; lock record says 0.6.0 and plugin-enabled | The plugin directory is **a symlink to this checkout**, now Pi package 0.7.0. This is not a preserved working OMP 0.6.0 installation |
| Legacy Decision preferences | Lock settings retain `@advisor`, `read,grep,glob`, Azure CLI, 0.8 threshold; scoring `enabled: false` | Old settings are not imported by the Pi extension. OMP compatibility of the current linked Pi code is unverified |
| Native advisor | `modelRoles.advisor` set, but no `advisor.enabled: true` in user YAML | Source default is false. A role assignment alone does not enable review; no running OMP session was inspected |
| Memory | No user memory override; source `memory.backend` default is `off` | Memory is an available OMP feature, not demonstrated active use |
| LSP | No user override; source defaults enabled/lazy, diagnostics-on-write true | Actual server availability depends on language and installed server prerequisites |
| Main routing/UI | `default` and `advisor` use Copilot `gpt-6.1-sol-1m`; `smol` uses `gpt-6-luna-1m`; titanium dark theme, band composer, Nerd symbols | Pi has a different model ID and no equivalent role/cycle configuration in current settings |

`omp plugin list` resolves the linked package as `pi-decision-advisor@0.7.0`. That confirms the stale-link issue, not successful extension execution under OMP.

## 2. Functionality comparison

“Gap” below means missing from **this Pi installation**, not impossible to implement using Pi's extension APIs.

| Area | OMP baseline | Pi + installed extensions | Gap / impact |
|---|---|---|---|
| Ordinary file operations | Rich read/write and hashline edits | Stock text/image reads, exact replacements, writes | Basic coding covered; edit format and stale-file handling differ |
| Search/discovery | Native in-process grep/glob and shared scan cache | Stock grep/find/ls plus shell rg/fd | Functional alternative, not native performance parity; primary selection currently uses bash |
| Structured file access | Direct archives, SQLite, notebooks, PDFs; selectors and structural summaries | Stock read handles text/images; web extension adds fetched PDF extraction | No integrated local structured-file/selector surface; use tools/CLIs explicitly |
| AST operations | `ast_grep`, staged `ast_edit`, proposed-change resolution | No AST extension installed | Missing structural query/refactor and preview/accept protocol |
| LSP | Definitions/references/symbols/rename/actions, shared servers, diagnostics-on-write | No LSP extension installed | High-impact coding gap; manual compiler/linter runs are not semantic navigation/refactoring |
| Debugging | DAP tool, stepping, threads, stack, variables | Shell access only | Can launch debuggers manually; no structured debugging session/tool |
| Persistent execution | Eval Python/JS kernels and tool re-entry; persistent agent shell/background work | Stock bash; built-in codemode available but inactive; Powerline managed shell for user bash mode | Codemode is sandboxed tool composition, not a scientific/kernel REPL. User bash persistence is not agent bash persistence |
| Subagents | Task fan-out, typed outputs, workspace isolation, peer communication, live Agent Hub | No subagent extension installed | Highest orchestration gap; parallel tool calls do not create autonomous workers |
| Planning/task state | Native todo, ask, plan mode, work orchestration keywords | Normal prose; extension dialogs exist but no installed primary todo/ask/plan workflow | No corresponding task-state/structured-question tool or guarded plan mode |
| Change review | `/review` reviewer agents, priorities/verdict, diff annotation | Decision reviews individual turns; shell can inspect diffs | Decision is not branch/commit review. No dedicated parallel code-review or line-annotation workflow |
| Memory/learning | Selectable memory backends, retain/recall/reflect/edit, learn/manage_skill | Sessions and static skills supported; no memory extension/backend installed | No automatic durable fact recall or managed learning; OMP memory currently defaults off too |
| Web research | Built-in multi-provider web_search and rich URL read | Web Access search, source_check, fetch_content, cached retrieval, PDF/video support | Broad coverage with different tool contracts; OMP `read URL` is not Pi `read URL` |
| Source checking | Web citations and researcher workflows | `source_check` returns exact passages/hashes for manual review | Useful Pi addition, but artifact status does not automatically establish semantic truth |
| GitHub | Rich URI routing, optional GitHub CLI tool, specialized PR/issue read | Web Access specialized repo/PR/issue fetch and stock bash/gh | Read access substantially covered; no OMP URI graph or dedicated ops/watch surface |
| Browser/desktop | Browser relay, Chromium/Electron control, host screenshots/input/accessibility | Web extraction/curator only; no configured browser MCP server | A curator browser UI is not agent-driven browser or desktop automation |
| Media | Image generation, speech, computer tools, PDF/image processing | Input images; Web Access PDF/video/image fetching | No installed image-generation/TTS/desktop tools; some OMP tools are gated off by default |
| Internal filesystem | `agent://`, `proc://`, `pr://`, `conflict://`, `xd://` and other schemes | Local paths plus separate web/MCP tools | No uniform URI-based agent/artifact/conflict/device graph |
| Git workflow | `omp commit` atomic split/dependency workflow, conflict URI resolution | bash/git (and external jj on this host) | No integrated commit splitting/validation or conflict device workflow |
| Sessions/context | Branch/resume/export, rewind/checkpoint and advanced maintenance | Stock tree/fork/resume, compaction, HTML export | Core lifecycle covered; no installed rewind/checkpoint workflow. Session schemas/storage are not interchangeable |
| Model routing | Roles, fallback chains, credential rotation, path-scoped models | Default/model picker/scoped cycling; virtual-model API and provider extensions available | No role-router/fallback extension installed; same provider name does not prove equal IDs or context limits |
| Rules/discovery | Multi-host settings/rules/skills/MCP discovery, TTSR stream-triggered rules | AGENTS/CLAUDE, `.pi` and `.agents/skills`; adapter supports explicit foreign imports | No general OMP importer/rulebook/TTSR equivalent installed |
| MCP | Integrated discovery, tools/resources/transports, approval/runtime | Native MCP plus adapter's lazy gateway, resources/prompts/OAuth/UI/scripting | Strong potential coverage, but actual adapter integrations = zero; differing discovery and ownership must be intentional |
| Editor protocol | ACP and editor-routed filesystem/terminal/permissions | Stock RPC/SDK, no ACP bridge installed | RPC is not a drop-in ACP implementation |
| Collaboration | `/collab`, remote join/view and peer controls | No collaboration extension installed | Missing live relay/pairing and shared-agent controls |
| Terminal convenience | Native themed composer, status, hub, annotation | Powerline footer/editor, stash, quote/reply, queue, persistent user bash mode | Good convenience coverage, not OMP hub/composer parity; `/vibe` means loading-message theme here, not OMP director/worker mode |
| External supervision | Installed Herdr OMP state/session reporter | No Pi Herdr integration found | Herdr environment is present in this session, but no Pi reporter is installed |

## 3. Decision advisor: retained features and intentional differences

The 0.7.0 migration retains batched five-rubric Azure System One triage, configurable pass threshold/timeouts, explicit diagnostics, isolated tool-enabled escalation, sanitized evidence/results, private preferences, and durable rendered review/score entries.

| Concern | OMP native advisor | Current Pi Decision extension | Assessment |
|---|---|---|---|
| Review eligibility | Configurable every-turn or agent-end/interval review | Score every completed primary turn; invoke chat reviewer only on failed/unassessed scoring or explicit review | Different cost/coverage policy, not equivalent always-on review |
| Delivery | Notes may steer/resume according to severity, cadence, stop/mode constraints | Never requests primary continuation; projects saved reviews into subsequent natural requests while source entry remains in context | **Intentional safety/behavior change**; cannot promise immediate correction of a terminal answer |
| Roster | Multiple named WATCHDOG reviewers and shared/project instructions | One explicitly selected reviewer; instructions string and bounded completed summaries | No multi-reviewer roster, WATCHDOG discovery, per-reviewer cadence/backlog |
| Context/history | Persistent private advisor history with compaction/re-prime and full transcript recording | Fresh in-memory Agent per review; default three prior summaries, capped at eight and 16 KiB | Long-running investigative continuity is reduced intentionally |
| Tools | Constructed OMP built-ins, optional memory, normal host approval policy | Stock allowlisted tools only; no ambient MCP, extensions, skills, rules or subagents | Primary web/MCP extensions do **not** enhance the reviewer |
| Elevated actions | Uses OMP approval settings (default yolo) | Every bash/powershell/edit/write operation needs fresh UI confirmation; headless denied | Stricter reviewer gate, not a global Pi primary approval system |
| Reasoning | Native advisor defaults medium, configurable suffix/auto | Reviewer Agent starts `thinkingLevel: "off"`; no reviewer-effort preference | Configurability gap; model-specific behavior without controllable effort is not proven |
| Evidence size | Native token-aware context maintenance | Conservative 28,000 serialized UTF-8 byte evidence allowance; oversized evidence rejected | Large context is not fully reviewed. Pi primary context size does not increase this limit |
| Failure recovery | Native credential/fallback recovery and quota pause, backlog policy | Bounded scoring/reviewer deadlines; errors persisted, no successful accept on failed tools | No extension-owned reviewer fallback chain or native backlog recovery |
| Observability | Full advisor JSONL, Agent Hub, independent token/cost ledger and dump | Score/error/review custom entries with model/verdict/findings | **Missing full reviewer tool/call transcript and usage attribution** |
| Accounting | Native advisor spend survives resets/resume | ReviewResult and DecisionReport have no usage/cost; isolated Agent usage is not aggregated into parent entries | Footer/session totals should not be treated as inclusive reviewer/scoring spend |

### The repeated “no findings” messages

`src/index.ts` emits the exact sentence in the supplied turn 1–8 messages when a completed review has `verdict: "accept"` and an empty findings array. It emits different text for uncertain empty reviews and reviewer failures.

Those messages therefore describe the renderer's accepted-review branch, **not** proof that Decision scoring passed or the work is objectively correct. A reviewer can accept a first-stage flag or review without a score. The current preferences are off; the supplied earlier messages alone do not establish when they were produced, which score triggered them, or whether they are active persisted entries rather than copied messages.

## 4. Confirmed configuration and operational gaps

### G1 — Development launcher isolation mismatch (high)

`scripts/pi.ts` launches the executable named `pi` with `--no-extensions --extension <local src/index.ts>`. On this host, that executable is a Nix wrapper which first adds three explicit extension paths. Pi explicitly allows `-e` paths despite `--no-extensions`.

**Observed offline RPC result:** both ordinary Pi and `npm run pi -- --mode rpc --no-session` register MCP Adapter, Powerline, Web Access and Decision. Normal Pi also registers stock `/mcp` and `/llama`; the development launch does not. In the development launch `/mcp` instead belongs to MCP Adapter. Thus the launch is not an advisor-only host, and even command ownership changes between entry points.

Recommendation: if isolated development is required, explicitly invoke the underlying unwrapped host, or add a supported wrapper bypass. Otherwise document the wrapper extensions as part of the development environment. Do not assume `--no-extensions` defeats explicit wrapper injection.

### G2 — Split MCP ownership/configuration (high for migration)

Normal startup keeps **both** implementations: RPC `/mcp` points to stock `builtin:mcp`, while `/mcp-adapter` points to the adapter. The adapter only registers a `/mcp` alias if the native command is absent; the loaded source checks `pi.getCommands()` for that owner.

- Native config: `~/.pi/agent/mcp.json`, `.pi/mcp.json`.
- Adapter config: shared `.mcp.json`, `~/.config/mcp/mcp.json`, `.agents` compatibility paths, `mcp-adapter.json`.
- Adapter 4.0.0 explicitly does **not** read Pi native `mcp.json` files.
- `mcp({})` in this session reported zero adapter servers/tools; this is not a query of native MCP state.
- `pi mcp ...` shell commands belong to the stock implementation, not the adapter gateway.

Recommendation: choose/document ownership per server. Avoid accidentally declaring the same server in both stacks. Use `/mcp-adapter` for gateway integrations and `/mcp` for native integrations in normal Pi; confirm command provenance after launcher changes.

### G3 — Nix extensions invisible to package commands (medium)

`pi list` lists only the local Decision package. The wrapper-managed extensions are explicit CLI resources, not user package declarations. `pi remove`/`pi update --extensions` do not manage their immutable Nix copies. The wrapper injects them even with `--no-extensions`.

Recommendation: maintain the complete roster in Nix; rebuild to update/remove Nix extensions. Include wrapper arguments in runtime audits, not just settings and `pi list`.

### G4 — Stale OMP plugin symlink and settings (high if OMP is still used)

OMP's plugin declaration/lock describes the legacy plugin but resolves to the migrated Pi checkout. Settings still use `@advisor` and `glob`; Pi 0.7.0 deliberately rejects/does not import that configuration. OMP module compatibility rewriting is not proof that Pi lifecycle/projection/preferences behave correctly on OMP.

Recommendation: remove the obsolete OMP link for a clean cutover, or pin a separate known-working OMP release/check-out if dual-host support is required. Do not update the shared path expecting independent OMP/Pi versions.

### G5 — No declarative Decision package/preferences cutover (medium)

The three Nix-managed Pi extensions are pinned, but Decision is a mutable user-configured checkout. Its private preference file is separate from Nix's extension roster. A new/rebuilt host does not automatically acquire this user package/config from `pi.nix` alone.

Recommendation: document bootstrap/install of Decision and non-secret preferences separately, or package a pinned source declaratively. Keep credential material outside the Nix store.

### G6 — Capability prerequisites and activation (medium)

`rg`, `fd`, `gh`, and `az` are on PATH. `ffmpeg` and `yt-dlp` are not on PATH; Web Access frame extraction cannot be assumed available. No `web-search.json` was found in the normal Pi agent directory, and no live search/PDF/video provider was tested. Config/env/provider auth may still influence availability.

The current primary exposes `web_enable`, not the full web tools. This is normal dynamic activation, not a missing installation. `source_check` supplies evidence for semantic review; it is not an automatic truth judge.

Recommendation: verify desired providers explicitly; install media prerequisites only if needed; test activation on new/resumed sessions and model switches. Do not report “all web providers work” from package installation alone.

### G7 — Herdr lifecycle integration absent (high for supervised workflows)

Herdr environment is present, but the installed reporter exists only under OMP. Its code handles approval/ask blocked states, retries and session association. Merely copying it to Pi is insufficient: OMP-specific events and the `OMPCODE` nesting guard need adaptation, and Pi's final idle boundary is `agent_settled`, not low-level `agent_end`.

Recommendation: add a separate Pi integration with session association, true settled-idle detection, provider failure handling and blocked-dialog coverage. Test tool loops, retries, reload, branch/resume and nested sessions.

## 5. Prioritized closure plan

| Priority | Work | Acceptance criteria |
|---|---|---|
| P1 | Decide Pi-only vs dual-host support; resolve stale OMP link | Each host resolves a supported package/version and its own valid settings; no shared mutable cross-host install |
| P1 | Make launch inventory/ownership explicit | Automated offline inventory checks normal and development commands; expected extensions and `/mcp` owner are asserted |
| P1 | Port Herdr integration if it is operationally required | Working/blocked/idle and session association remain correct through tools, retries, cancellation, reload and resume |
| P1 | Add LSP and subagent workflows if OMP parity is required | Semantic rename/navigation + diagnostics; isolated workers with validated outputs, cancellation and result visibility |
| P2 | Add Decision usage and diagnostic observability | Persist sanitized request/tool timing and token/cost metadata without raw credentials; distinguish scoring vs reviewer spend and unavailable usage |
| P2 | Verify Decision end-to-end while intentionally enabled | Synthetic good/bad discrimination; forced scoring failure; findings on next natural prompt; no feedback-triggered primary turns; TUI/RPC/headless gates |
| P2 | Provision required MCP integrations intentionally | Correct config owner, trust, OAuth, read-only/destructive approval and failure behavior verified per server |
| P2 | Validate web research/media subset | Search + source passage retrieval + PDF extraction; optional ffmpeg/yt-dlp frame extraction; privacy/remote-provider policy tested |
| P3 | Recover selected advanced OMP workflows | Add only needed AST/DAP/memory/ACP/collab/commit tools, each with explicit permissions and tests |

Avoid trying to recreate every OMP feature in the Decision extension. It is intentionally a narrow reviewer; orchestration, primary permissions, LSP, Herdr and collaboration belong in separate integrations.

## 6. Verification performed and remaining limits

Performed:

- Resolved installed Pi/OMP paths and versions; inspected Nix manifests and Pi wrapper.
- Read user preferences and extension/plugin manifests without opening credential files.
- Queried `pi list`, `omp plugin list`, and current MCP adapter status.
- Started normal and development Pi in offline, in-memory RPC mode; queried `get_commands`. Both returned successfully with no stderr diagnostics.
- Inspected Decision lifecycle/reviewer/types, Herdr source, OMP feature docs/settings, and installed Pi/extension docs.
- `npm run check`: passed.
- `npm test`: **136 passed, 0 failed**. This validates local regression behavior, not live Azure quality or full host parity.

Not performed:

- Live Azure deployment/auth/inference checks, provider quality/calibration or reviewer-spend measurement.
- OMP runtime extension execution; exact installed binary/source equivalence.
- Native MCP connection inventory, any live MCP server, browser/desktop/ACP/collab use.
- Interactive comparison of the complete Pi/OMP TUI and all Powerline/Web Access behavior.
- Automatic conversion or deletion of host configuration.

## Evidence index

Repository-relative implementation:

- `package.json`: Pi package 0.7.0, manifest and stock Pi peer dependencies.
- `src/index.ts`: scheduling, context projection, entry rendering and accepted-review text.
- `src/review.ts`: isolated Agent, selected model/tools, thinking off and cancellation.
- `src/types.ts`: reports/results lack usage/cost fields.
- `scripts/pi.ts`: explicit extension plus discovery-disabled development launcher.
- `README.md`: extension contracts and intentionally unsupported OMP integrations.

Host/local sources (not portable repository links):

- `/home/nixos/git/nix-config/pi.nix`, `pi-extensions/package.json`, `oh-my-pi.nix`.
- `/nix/store/8iin213b6rn01w2m31dqz4s6ja55l410-pi/bin/pi`: actual shell wrapper.
- `~/.pi/agent/settings.json`, `~/.pi/agent/decision-advisor.json`.
- `~/.omp/agent/config.yml`, `~/.omp/agent/extensions/herdr-omp-agent-state.ts`.
- `~/.omp/plugins/package.json`, `omp-plugins.lock.json`, linked `node_modules/omp-decision-advisor`.
- `/home/nixos/git/oh-my-pi/README.md`, `docs/advisor-watchdog.md`, `docs/approval-mode.md`, `docs/extension-loading.md`; domain settings in `packages/coding-agent/src/`.
- Installed Pi docs under `$PI_PACKAGE_DIR/docs/`: extensions, packages, CLI, settings, configuration, MCP, models, virtual-models, RPC, skills, themes, TUI and security.
- Installed extension READMEs and adapter command-ownership check under `/nix/store/gfjb9kljnk62mdyn4jqrr6747lwscr7s-pi-extensions-1.0.0/node_modules/`.
