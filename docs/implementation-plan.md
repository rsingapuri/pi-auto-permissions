# Proof-linked implementation plan

Status: normative construction and verification plan for the current
implementation. Every step below names the invariants it supports, and the
release claims are limited to the executable evidence listed in Sections 3-5.

## 1. Architecture

The package has eight narrow components:

1. `state/`: atomic global configuration and per-session requested mode;
2. `policy/`: canonical requests, path classification, dangerous-command rules,
   and admission routing;
3. `guardian/` and `pi/`: pinned Guardian prompt, transcript projection, model invocation,
   strict verdict parser, deadlines, and denial circuit breaker;
4. `sandbox/`: a fixed macOS/Linux shell sandbox plus ReviewOnly fallback;
5. `runtime/`: the non-executing admission state machine and exact review binding;
6. `tools/`: Pi tool interception and the sandbox-aware `bash` override;
7. `commands/`: `/perm`, `/perm-auto-model`, and `/perm-enabled`;
8. `extension.ts`: lifecycle wiring only.

No component may open a human approval dialog. UI selection belongs only to the
three explicit command handlers. Denial paths may emit a passive warning notice,
but that notice never requests approval.

## 2. Stepwise construction

### Step 1: reproducible package and provenance

- Target `@earendil-works/pi-coding-agent` `0.80.10` and Node `>=22.19`.
- License the package Apache-2.0.
- Pin runtime dependencies exactly and commit the lockfile.
- Vendor the minimum Codex Guardian policy/prompt material from revision
  `0fb559f0f6e231a88ac02ea002d3ecd248e2b515`.
- Record source paths, revision, modifications, Apache notice, and Pi MIT
  attribution for any adapted Pi example code.
- Add a CI test that verifies vendored hashes and attribution entries.

Guarantees supported: I13 and reproducible policy semantics.

### Step 2: canonical data model

- Define closed TypeScript unions for modes, backend, config health, and
  decisions; represent lifecycle invalidation with revisioned session state and
  the final admission/executor boundary.
- Implement deterministic, bounded canonical JSON with sorted keys.
- Reject unsupported values, excessive depth, cycles, non-finite numbers, and
  requests beyond the transcript/action budget.
- Bind every review to the canonical action, exact reviewer model and thinking
  level, plus global/session/backend revision.

Guarantees supported: I1, I8, I9, I10, I14, I15.

### Step 3: durable global state

- Store one private extension-owned JSON file under `getAgentDir()`; it is an
  implementation detail, never a user-edited configuration surface.
- Serialize writers with a cross-process lock.
- Allocate revisions through primary and recovery copies of one private
  monotonic watermark so a config fault plus one metadata fault cannot recreate
  an approval-visible revision.
- Under the same cross-process reader/writer lock, write mode `0600` temporary
  files in the same directory, file-sync, rename, and best-effort sync the
  directory; publish recovery watermark, primary watermark, then config.
- Reserve Missing for the all-three-absent first-run state. Treat every partial
  artifact set, malformed or unequal watermark pair, or watermark below the
  config revision as Fault. Repair above the greatest surviving valid
  watermark/config hint, and refuse repair when neither watermark is
  valid.
- Reread state at every tool gate so Off/model changes affect existing processes.
- Treat malformed or unknown config schemas as Fault.
- Permit explicit management commands to repair Fault.

Guarantees supported: I2, I4, I10, I13, I14.

### Step 4: session state

- Initialize requested mode to Auto for every runtime.
- Initialize backend to an unbound `null` value and form no Guardian binding
  until startup installs `sandboxed`, `review-only`, or `unavailable`.
- Store a non-model-visible custom session entry on mode changes solely so
  `session_start(reason="reload")` can reconstruct the same logical runtime.
- Ignore that entry for startup/resume/new/fork so privilege never persists into
  another runtime.
- Increment a session revision on each mode or lifecycle change.

Guarantees supported: I1, I2, I3, I8, I12, I14.

### Step 5: static file policy

- Normalize relative/absolute paths without shell interpretation.
- Resolve existing targets with `realpath`; for creation, walk to the nearest
  existing ancestor and append unresolved components without accepting `..`.
- Materialize workspace and temporary writable roots.
- Detect `.git` directories and gitdir pointer files; protect resolved Git data.
- Protect top-level `.git`, `.agents`, `.codex`, and `.pi` recursively.
- Statically deny the extension's durable state and lock roots before review.
- Auto-admit in-root non-protected `write`/`edit`; review all others.
- Auto-admit the known read-only built-ins.
- If policy construction fails, install a narrow fallback that admits only those
  read-only built-ins and denies every direct mutation.

Guarantees supported: I5, I8, I10, I14.

### Step 6: shell backends

- Pin and initialize the chosen Apache-2.0 sandbox runtime with a fixed policy:
  broad read, workspace/temp write, protected metadata read-only, no network.
- Support macOS and Linux after an actual capability probe.
- Override `bash` while retaining Pi's renderer and output/truncation behavior.
- Add optional `sandbox_permissions: "use_default" | "require_escalated"`.
- Run default non-dangerous calls exactly once inside the sandbox.
- Review default Codex-dangerous calls, then run an exact allow once inside the
  sandbox; approval alone never removes containment.
- Run approved escalations exactly once using Pi's ordinary local bash backend.
- On an unsupported platform, use ReviewOnly and review every bash call.
- On macOS/Linux dependency, initialization, capability-probe, or strong-sandbox
  failure, deny Auto bash calls; never weaken to ReviewOnly.
- On ambiguous runtime failure, never replay the same call; degrade only future
  calls when infrastructure failure is established.
- Serialize ownership of Sandbox Runtime's supported-host process-global
  manager. Convert an additional same-process owner attempt to an unavailable
  backend, release ownership only after drain and successful reset, and poison
  reuse until process restart if final reset fails.
- Do not sandbox explicit user `!`/`!!` commands.

Guarantees supported: I5-I10, I14, I17.

### Step 7: Codex-compatible reviewer

- Use the globally selected Pi model and explicitly selected supported thinking
  level without changing the main session model or its thinking level.
- Resolve credentials through Pi's model registry; never persist credentials.
- Disable tools in the review request.
- Provide a bounded compact transcript and exact canonical action.
- Use the pinned Codex risk taxonomy and verdict schema, modified only to remove
  human override/request paths.
- Enforce one aggregate 90-second deadline and at most three attempts.
- Parse exact JSON; normalize no prose and never infer an allow.
- Treat every non-allow/failure as denial and return one fixed denial string.
- Track three consecutive and ten-of-fifty per-turn denial breakers.

Guarantees supported: I5, I6, I8-I11, I14-I16.

### Step 8: commands and status

- `/perm` accepts `auto` or `unrestricted`; no argument opens a two-item selector
  only when interactive.
- Reject `/perm auto` without a configured reviewer, leaving state unchanged.
- `/perm-auto-model` accepts an exact `provider/model` plus thinking level or
  uses interactive model and supported-level pickers; validate model existence,
  level support, and auth before one durable tuple commit; set the current
  requested mode to Auto after success.
- `/perm-enabled on|off` commits globally and affects other processes at their
  next gate.
- Keep all commands available while disabled or in Fault.
- Report `Auto`, `Auto (review-only)`, `Auto (sandbox unavailable)`,
  `Auto (configuration fault)`, `Unrestricted`, or `Off` for an active engine;
  backends are not selectable.
- If engine construction catastrophically fails, retain the already-registered
  fail-closed tool gates, publish `Auto (unavailable)`, and leave commands
  non-mutating until a later successful session initialization.

Guarantees supported: I1-I4, I11-I13, I17.

### Step 9: Pi lifecycle integration

- Register one handler per event and make repeated reload initialization
  idempotent.
- Capture the final action as seen by this extension and compare it again before
  returning allow.
- Abort pending reviews on same-runtime session shutdown, local mode/global
  command changes, backend failure, or Pi cancellation. Detect sibling-process
  global commits at the next pre-model, post-model, or final binding read; they
  cannot push an abort signal into another process.
- Treat final admission as the permission linearization point. A policy commit
  after that point does not revoke an action already admitted once.
- Never hold the state lock while calling a model, spawning a process, or waiting
  for UI.

Guarantees supported: I8-I10, I14, I15.

## 3. Test strategy

Tests form four concentric layers. A release requires all applicable layers.

### 3.1 Unit and deterministic boundary tests

- Exhaustive effective-mode truth table.
- Session revision/liveness transitions and denial-before-executor boundaries.
- Stable canonicalization across object order and Unicode inputs.
- Deterministic boundary cases for cycles, accessors, sparse arrays, depth,
  nodes, bytes, non-finite numbers, and unsupported values.
- Path corpus: relative, absolute, `..`, prefix collisions, symlinks, dangling
  symlinks, missing ancestors, temp roots, gitdir files, and protected paths.
- Pinned Codex dangerous-command corpus: forced `rm`, wrappers, depth limit,
  chains, pipes, substitutions, control flow, malformed shell, and false-positive
  cases.
- Strict verdict matrix: allow, deny, ask, empty/missing/extra/wrong fields,
  prose, fences, duplicate JSON, multiple JSON values, and oversized output.
- Circuit-breaker consecutive and rolling-window boundary sequences.
- Sandbox-controller state tests for singleton ownership, command leases,
  runtime failure, successful reset, and permanent process poison after a
  failed final reset.

### 3.2 Component integration tests

- Real atomic writes with multiple processes racing reviewer-tuple updates.
- Missing, malformed, truncated, wrong-version, wrong-shape, and repeatedly
  repaired config, including two-watermark monotonicity and disagreement.
- Injected first-watermark, between-watermark, and first-config rename failures
  assert old-config preservation, explicit Fault, cleanup, and monotonic repair
  as applicable. An instrumented filesystem verifies file-sync, rename, and
  best-effort directory-sync ordering for recovery watermark, primary watermark,
  and config.
- Fake Pi model provider: allow, deny, malformed, transient failures, timeout,
  cancellation, missing auth, and unavailable model.
- Binding races: reviewer/thinking revision change, Auto -> Unrestricted ->
  Auto, backend change, session shutdown, argument mutation, and delayed static
  classification.
- Assert action denials do not call confirmation, free-form-input, editor, or
  selector UI.

### 3.3 Real sandbox tests

On macOS and Linux CI hosts, run actual child processes and assert:

- workspace and temporary writes succeed;
- outside and protected writes fail;
- network access fails;
- descendant shell processes inherit restrictions;
- symlink escapes, shell substitutions, and a Node interpreter cannot escape the
  same boundary;
- workspace policy remains valid when the Pi session cwd differs from the Node
  process cwd.

Controlled controller/integration tests, rather than the native process test,
cover dependency/probe/runtime failure, shutdown draining, no replay after an
ambiguous execution failure, and approved/denied escalation counts.

Unsupported-platform behavior is tested with injected platform probes: every
bash call is reviewed, allow executes once, and every other outcome executes zero
times. Deterministic supported-platform dependency, initialization, and probe
failures assert that Auto bash executes zero times; runtime-failure cases assert
that no later call executes and a possibly started call is never replayed.

### 3.4 Black-box Pi E2E tests

Use Pi's public `ExtensionRunner`/`DefaultResourceLoader` and a real
`AgentSession` bound in print mode, with deterministic faux providers and
temporary agent/workspace directories. These tests do not claim packaged CLI,
RPC, JSON-mode, or live TUI coverage.

Cover:

- empty first run and unavailable Auto;
- first model/thinking-level selection and immediate Auto; command unit tests
  separately cover level-only changes and interactive selection;
- reload restoration and fresh `startup`, `resume`, `fork`, and `new` event
  reasons, including independent child/grandchild runtime simulations;
- Auto, Unrestricted, and Off routing, plus configured/unconfigured reviewer and
  sandboxed/review-only/unavailable backend cases;
- every built-in tool and a representative custom tool;
- model-authored slash-like text cannot change settings;
- explicit user commands can change settings;
- Off/on and reviewer changes observed by already-running sibling runtime
  simulations;
- denial is an `isError` tool result visible to the model, with a passive user
  warning notice and no UI dialog;
- the model can continue with a safer call after denial;
- the shipped TypeScript entrypoint loads through Pi's resource loader and the
  no-dialog path completes in print mode.

## 4. Invariant-to-test traceability

| Invariant | Required evidence |
|---|---|
| I1-I4 | mode/state truth table, extension-runner session cases, and multi-process config writers |
| I5 | route/executor assertions and a real `AgentSession` denial whose custom executor remains uncalled |
| I6-I7 | real process/network/filesystem sandbox test, controller tests, and ReviewOnly E2E |
| I8-I9 | canonical binding, revision race, and exactly-once sentinel tests |
| I10 | deterministic config/model/classification/sandbox failure cases |
| I11-I12 | UI spies and model-authored command tests |
| I13 | multi-process writers, rename-failure preservation, and durable-I/O ordering |
| I14 | reviewer/thinking, mode-ABA, backend, lifecycle, and action-mutation race tests |
| I15-I16 | aggregate-deadline tests, queue bounds, parallel denial races, and breaker sequences |
| I17 | capability/init-failure status and execution-path assertions |

An explicit manifest maps every invariant `I1` through `I17` to an exact test
file and title fragment. The traceability test checks the complete key set, each
file's existence, and each named witness; deleting or renaming claimed evidence
therefore fails CI. The substantive evidence remains the assertions summarized
in the table above.

## 5. Release gates

A release is blocked unless:

1. type checking plus deterministic unit, integration, and Pi E2E tests pass;
2. the opt-in real sandbox test passes on the configured Ubuntu 22.04 and macOS
   14 CI hosts;
3. unsupported-platform ReviewOnly and supported-platform fail-closed tests pass;
4. vendored policy hashes and all third-party notices are current;
5. dependency audit and SBOM generation complete;
6. the explicit invariant-to-named-test traceability manifest passes;
7. README limitations match Section 7 of the invariant specification;
8. no-dialog unit/E2E assertions pass and the action-review modules retain no UI
   dependency.

The project may be shipped from tests without an informal manual trial only when
these executable release gates are satisfied on the release commit. This plan
does not represent absent fuzzing, packaged-CLI matrices, or manual TUI/RPC/JSON
exercises as completed evidence.
