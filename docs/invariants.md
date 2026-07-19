# Permission-system invariants

Status: normative design specification.

Upstream reference points:

- Pi `0.80.10`, source revision
  [`3da591ab74ab9ab407e72ed882600b2c851fae21`](https://github.com/earendil-works/pi/tree/3da591ab74ab9ab407e72ed882600b2c851fae21).
- Codex Guardian and approval behavior, source revision
  [`0fb559f0f6e231a88ac02ea002d3ecd248e2b515`](https://github.com/openai/codex/tree/0fb559f0f6e231a88ac02ea002d3ecd248e2b515).

This document defines what the extension guarantees, the assumptions under which
those guarantees hold, and why the state machine has no path to the pathological
behaviors called out in the product requirements.

## 1. Scope and trust boundary

The extension is a permission guardrail for model-originated Pi tool calls. It is
not a security boundary against the user, the operating-system kernel, Pi itself,
or arbitrary extension code already trusted and loaded into Pi's process.

The proof assumes:

1. Pi invokes the extension's `tool_call` handler before executing each
   model-originated tool call and honors `{ block: true }`.
2. Other loaded extensions are trusted: they do not mutate a reviewed request
   after this extension's handler returns, replace this extension's guarded
   built-ins later, or perform effects unrelated to their declared tool call.
3. User-entered `!` and `!!` commands are user-authorized actions and are outside
   the model-action guardrail.
4. The selected review model, model provider, Pi runtime, sandbox runtime, OS,
   filesystem, and kernel may fail, but are not maliciously subverted.
5. Semantic correctness of an LLM verdict is not provable. The extension proves
   routing, binding, failure, and execution properties around that verdict.
6. A hostile local process racing path checks is outside the threat model. Static
   file policy still resolves existing symlinks and the nearest existing ancestor
   so ordinary path indirection cannot accidentally broaden a request.
7. Durable-state proofs cover store-authored atomic-write failures and corruption
   of the config together with at most one of the two revision-metadata
   artifacts. Simultaneous destruction or malicious replacement of both private
   revision watermarks is a hostile-local-process case and is outside scope; the
   store refuses to guess a revision in that state.

Third-party tools are policy-reviewed when Pi exposes them through `tool_call`,
but their implementation is the installing user's responsibility and is not
claimed to be OS-sandboxed.

## 2. State

### 2.1 Durable global state

Let the only durable permission state be

\[
G = (v, enabled, reviewer, revision)
\]

where:

- \(v = 1\) is the configuration schema version;
- \(enabled \in \{true,false\}\);
- \(reviewer \in \{None, (provider, modelId, thinkingLevel)\}\), where
  `thinkingLevel` is one of the levels Pi reports as supported by that exact
  model;
- \(revision \in \mathbb{N}\) increases on every committed global mutation.

For store-authored state, the store also maintains two private durable copies of
one allocation watermark, \(counter = recovery \ge revision\). They are not
permission configuration and are never consulted to choose a mode; they exist
so a repair cannot reuse an old revision after malformed JSON erased the
embedded value. A publication durably advances the recovery watermark, the
primary counter, and then the config while holding the same cross-process lock
used by readers. Failure may skip a revision but can never reuse one on a later
store-authored commit.

The configuration also has a derived health value:

\[
health(G) \in \{missing, valid, fault\}.
\]

`missing` is reserved for the all-three-absent first-run state and means
`(enabled=true, reviewer=None, revision=0)`. Invalid JSON, an unknown schema,
invalid field types, malformed revision metadata, a missing half of the
watermark pair, unequal watermarks, a watermark below the config revision, or a
missing config accompanied by either watermark produce `fault`; they never
produce permissive defaults for a guarded action. A metadata fault remains Fault
until an explicit management mutation safely repairs and publishes both
watermarks plus the complete config.

Reads and writes are serialized across processes. Each watermark and then the
complete config is written to a private temporary file, file-synced, and
atomically renamed; the containing directory is synced where the filesystem
supports it. A live reader therefore never observes the staged intermediate
files of a concurrent writer. If a crash leaves unequal or malformed metadata,
the composite read is Fault. Explicit repair takes the maximum valid config
hint and surviving watermark, advances it, and restores both metadata artifacts
before publishing a healthy config. If neither watermark is valid,
repair refuses because monotonicity cannot be proved. Equal watermarks may be
ahead after a failed config publication, which only creates a harmless revision
gap. A process failure after config rename but before acknowledgement has an
intentionally ambiguous outcome: a later read of the monotonic revision is
authoritative.

### 2.2 Per-session state

For each Pi extension runtime \(i\):

\[
S_i = (requestedMode_i, sessionRevision_i, backend_i, alive_i)
\]

where:

- \(requestedMode_i \in \{Auto, Unrestricted\}\);
- \(sessionRevision_i \in \mathbb{N}\) increases on every session-local policy
  change;
- \(backend_i \in \{\bot, Sandboxed, ReviewOnly, Unavailable\}\), where
  \(\bot\) is the transient, not-yet-probed value used while the runtime is
  initializing;
- \(alive_i \in \{true,false\}\).

`backend` is an enforcement implementation detail, not a third user-visible
permission mode. The complete reviewer tuple is one atomic setting: a thinking
level is never inferred at review time from the main session, and changing only
that level increments the global revision just like changing the model.

The production extension does not publish an active session until probing has
replaced \(\bot\) with a concrete backend. A shell gate or reviewed-action gate
that nevertheless encounters \(\bot\) denies because no review binding can be
formed. A fresh state starts at revision zero; reload reconstruction advances the
stored checkpoint revision, and each actual backend, mode, or lifecycle change
advances it again.

Every new, resumed, forked, cloned, or independently spawned Pi runtime starts
with `requestedMode=Auto`; it never copies a parent's mode. A Pi `/reload`
reconstructs the prior requested mode for that same logical runtime. If no
reviewer is configured, Auto is unavailable and its effective behavior is
Unrestricted until a reviewer is selected. Selecting the first reviewer sets
the invoking session's requested mode to Auto.

Define the effective mode:

\[
effective(G,S_i) =
\begin{cases}
Disabled & health(G)\neq fault \land enabled=false \\
Unrestricted & requestedMode_i=Unrestricted \\
Fault & health(G)=fault \land requestedMode_i=Auto \\
UnrestrictedUnavailable & health(G)\neq fault \land enabled=true \land reviewer=None \\
Auto & health(G)\neq fault \land enabled=true \land reviewer\neq None.
\end{cases}
\]

`UnrestrictedUnavailable` is displayed simply as Unrestricted with Auto marked
unavailable. It remembers the default Auto intent so already-running default
sessions become Auto when the first reviewer is selected. An explicitly selected
Unrestricted session remains Unrestricted.

### 2.3 Enforcement backend

At startup the extension probes the shell sandbox without executing a
model-originated command:

- supported macOS/Linux plus successful dependency checks, initialization, and
  a real contained-process probe yields `Sandboxed`;
- an unsupported operating system yields `ReviewOnly` and a non-blocking
  warning;
- a macOS/Linux dependency, initialization, or probe failure yields
  `Unavailable` and denies Auto shell calls rather than silently weakening the
  expected platform boundary;
- an indeterminate state denies shell execution until it resolves.

Sandbox Runtime is process-global. On a supported host, exactly one controller
in a Node process owns it at a time. Another same-process supported-host session
cannot install a different policy while that owner is active: sandbox creation
is converted to `Unavailable`, so that session's Auto shell calls fail closed.
Positively unsupported hosts do not claim the singleton and may independently
use ReviewOnly. Shutdown releases ownership only after active command leases
drain and Sandbox Runtime resets successfully. If that final reset fails, the
owner slot is poisoned for the rest of the Node process; later supported-host
sessions remain `Unavailable` until process restart rather than reusing possibly
stale process-global policy.

If sandbox infrastructure fails before a future command begins, subsequent Auto
shell calls are denied. If a sandboxed process may have begun, that call is never
automatically retried. This prevents both duplicated side effects and an
unannounced downgrade on an operating system where containment is expected.

## 3. Canonical actions and lifecycle

A model action is canonically represented as

\[
A = Canon(toolName, arguments, cwd, toolMetadata).
\]

Canonicalization is deterministic: object keys are sorted, unsupported values are
rejected, strings are preserved byte-for-byte as UTF-8, and the result is bounded
in size. Review captures

\[
C = (A, reviewer, globalRevision, sessionRevision, backend, sessionId).
\]

Every action has exactly one lifecycle:

```text
Created -> Classified -> Admitted -> Executed
                    \-> Reviewing -> Admitted
                                  \-> Denied
                    \-> Denied
                    \-> Cancelled
```

`Executed`, `Denied`, and `Cancelled` are terminal. No transition leaves a
terminal state. `Executed` has only `Admitted` as a predecessor.

Admission is the linearization boundary between permission policy and tool
execution. For a reviewed action, it is the final successful binding read plus
the immediately following synchronous lifecycle/breaker check. For an
unreviewed route, its enabled-state ordering is determined by the global-state
read used by that gate, followed by the synchronous final lifecycle check. An
action linearized before a later policy commit may enter its executor once; the
extension does not claim to revoke or kill an action already admitted. An action
whose controlling read is after that commit must use the new state.

An Auto review admits an action only if all of the following hold:

1. the selected model returned an exactly valid `allow` verdict;
2. the request was not aborted and its session is alive;
3. the current reviewer model and thinking level equal the captured tuple;
4. current global and session revisions equal the captured revisions;
5. the current backend equals the captured backend;
6. the current canonical request equals the reviewed canonical request.

All other outcomes deny: explicit deny, `ask`, malformed output, missing model,
missing credentials, timeout, cancellation, queue exhaustion, oversized input,
provider failure, internal exception, revision change, backend change, or request
change. There is no fallback model and no conversion to Unrestricted.

During a review, the independent reviewer may call only fixed `read`, `grep`,
`find`, and `ls` implementations, resolved against the session cwd. These calls
are evidence gathering, not execution of the reviewed action; they expose no
mutation, shell, or network capability. They use bounded Node filesystem
operations and never execute or download search helpers. One review
permits at most four tool rounds and eight calls cumulatively across all retry
attempts, all within the same aggregate deadline. Missing local
context is not policy evidence of danger: the reviewer investigates when the
fact is material and otherwise denies only concretely evidenced severe,
irreversible risk.

## 4. Admission function

For a healthy enabled Auto session, classify built-ins as follows.

### 4.1 Read-only file tools

`read`, `grep`, `find`, and `ls` are admitted without model review. This matches
the broad-read property of Codex workspace-write and cannot directly create a
filesystem, process, or network side effect.

### 4.2 Direct mutation tools

For `write` and `edit`, let `target` be the canonical target resolved against
`cwd`, including existing symlinks or the nearest existing ancestor for a path
that does not yet exist.

`target` is statically admitted exactly when it is inside a writable root and is
not inside a protected metadata path. Writable roots are the session workspace,
the OS temporary directory, and `/tmp` where present. Protected metadata includes
top-level `.git`, resolved Git directories, `.agents`, `.codex`, and `.pi`.

Every other direct mutation is reviewed before the built-in executes. A denial
therefore causes zero effects from that tool call.

If the path policy cannot be constructed at session startup, the installed
fallback admits only the known read-only built-ins and statically denies direct
mutations. It does not guess a writable path or ask the reviewer to compensate
for missing path classification.

One narrower control-plane rule precedes this classification: Pi direct-file
tools may never mutate the extension's durable state or lock paths in Auto.
Those targets are statically denied without consulting the reviewer. This
prevents an ordinary `write`/`edit` call from turning an action review into a
permission-setting mutation.

### 4.3 Shell tool with a healthy sandbox

For `bash` under `Sandboxed`:

- an explicit `require_escalated` request is reviewed before execution;
- a command matching the pinned Codex dangerous-command rules is reviewed before
  execution, and an exact allow still runs inside the fixed sandbox;
- every other command executes once inside the fixed workspace-write sandbox.

The fixed sandbox grants broad reads, workspace and temporary-directory writes,
keeps protected metadata read-only, denies network access, and applies to the
spawned process tree.

A sandbox rejection is not a Guardian denial. It is returned as an ordinary tool
error. The model may choose a materially safer command or submit a new exact
`require_escalated` call for Auto review. The extension never retries the rejected
call itself.

### 4.4 Shell tool without a sandbox

For `bash` under `ReviewOnly`, every call is reviewed before any process starts.
An allow executes that exact command once with normal host permissions. Every
non-allow produces no process.

Thus unsupported platforms remain functional without ever executing an
unreviewed unsandboxed model command in Auto.

### 4.5 Failed supported sandbox

For `bash` under `Unavailable`, every call is denied before model review or
process creation. ReviewOnly is intentionally not used here: on macOS/Linux the
user is entitled to rely on containment being present, so an infrastructure
fault may reduce availability but cannot silently reduce enforcement.

### 4.6 Third-party tools

Unknown/custom tools are reviewed using their Pi-exposed name, description,
schema/source metadata, arguments, cwd, and conversation context. An allow lets
Pi call the trusted implementation; every non-allow blocks it. OS containment of
the implementation is explicitly outside scope.

### 4.7 Bypass states

`Disabled` and explicit `Unrestricted` admit model tool calls without this
extension's review or sandbox. They are deliberate user-authorized bypasses.

`Fault` denies guarded calls. User-only management commands remain available to
attempt a safe repair or deliberately choose Unrestricted. Repair refuses when
neither watermark is valid enough to prove a monotonic next revision.

`Unavailable` affects shell routing only: Auto direct-file and third-party tool
policy still operates, while every model-originated `bash` call is denied with an
infrastructure-specific safer-action result.

If construction of the permission engine itself fails after subsystem startup,
the extension publishes no active runtime, reports `Auto (unavailable)`, and its
already-registered bash and non-bash gates return the fixed denial. Because the
command host also requires an active runtime, the three extension commands
report failure rather than mutating state in this condition. A later successful
Pi session initialization (normally reload or process restart) is required to
recover. This catastrophic state is distinct from `Unavailable`, where the
engine is active and only Auto shell routing is unavailable. With no engine,
even a previously durable Off setting cannot be consulted by the outer gates;
they choose denial rather than an unverified bypass.

## 5. Normative invariants

### I1. Two-mode invariant

The only user-selectable modes are Auto and Unrestricted. Sandboxed, ReviewOnly,
and Unavailable never appear as selectable modes.

### I2. Auto-availability invariant

No session can effectively operate in Auto without a configured reviewer model
and an explicitly selected supported thinking level.

### I3. Fresh-session invariant

Every new session computes its requested mode independently as Auto. No parent or
previous session can propagate Unrestricted.

### I4. Global-disable invariant

For every active permission runtime, the durable `enabled=false` publication is
the global-switch linearization point. Every successful gate read of that state
after publication observes Disabled and bypasses this extension; a failed read
denies rather than guessing. A reviewed action whose binding read observes the
new revision cannot use an older allow. An action already linearized for
admission before the publication may execute once; Off is not a retroactive
process-kill mechanism. Re-enabling preserves each session's requested mode. A
catastrophic pre-runtime failure has no state reader and follows the fixed-denial
rule in Section 4.7.

### I5. Pre-execution denial invariant

A denied reviewed action reaches no executor for that action and creates no
process. The reviewer may already have performed bounded read-only evidence
collection. A normal sandboxed call may perform permitted effects before the OS
reports a later denied operation, but the extension never elevates or repeats it
automatically.

### I6. Unsandboxed-shell invariant

In effective Auto, an unsandboxed model-originated shell process starts only after
an allow verdict bound to that exact command and current state.

### I7. Sandboxed-shell invariant

In effective Auto with a healthy sandbox, an unreviewed shell command can start
only under the fixed sandbox policy.

### I8. Verdict-binding invariant

An Auto allow authorizes one canonical action under one captured reviewer tuple,
global revision, session revision, backend, and session. It authorizes no similar
action, retry, or future call.

### I9. Exactly-once orchestration invariant

The extension invokes an admitted tool at most once and never automatically
replays a call after denial, timeout, sandbox rejection, or ambiguous runtime
failure.

### I10. Fail-closed invariant

Review-protocol, binding, configuration, and containment uncertainty in a
guarded Auto path maps to denial before execution. Missing evidence about an
action does not itself establish dangerousness; the Guardian may investigate it
with bounded read-only tools. Classification uncertainty maps to Guardian review
or denial, never directly to unreviewed execution.
ReviewOnly is selected only by a positive unsupported-platform classification;
neither path ever maps to Unrestricted.

### I11. No-dialog invariant

No action-review branch invokes a user confirmation, selection, input, or editor
API. Denial returns a fixed tool result to the model:

> Permission denied. This action was not executed. No override will be requested.
> Choose a materially safer action.

User-facing selection UI exists only inside explicit user slash commands. A
permission denial may additionally emit a passive warning notification naming
the denied tool; that notification is not an approval request.

### I12. Direct-tool no-self-elevation invariant

Only Pi's explicit slash-command dispatch can invoke the extension's global
enablement, reviewer-selection, or session-mode mutations. Auto direct-file
tools are additionally denied access to the durable control-plane paths. Tool
text, reviewer output, and assistant prose cannot invoke the command handlers.
This does not claim containment after an approved host-level shell or trusted
custom-tool call; those trust-boundary cases can alter any same-user file.

### I13. Atomic-configuration invariant

Readers observe one complete old or new global state, never a field-wise mixture.
A failure before the first metadata rename leaves the old state; a failure
between metadata renames produces explicit Fault; a failure after both metadata
renames but before config publication leaves either a harmless gap above an old
config or, when no prior config exists, explicit Fault. Explicit repair
publishes a revision strictly above every surviving valid watermark and does not
report healthy until both metadata copies and the complete config agree. A
post-config-rename/pre-acknowledgement failure is resolved by rereading rather
than assuming either outcome.

### I14. Stale-review invariant

Any relevant global, session, backend, lifecycle, or request change between review
capture and a binding read makes that verdict non-admitting. Same-runtime command
and lifecycle changes also abort the local review signal. Changes committed by a
sibling process cannot actively abort provider I/O; they are detected at the
next applicable pre-model, post-model, or final binding read, and the bounded
review then denies. A change after final admission is governed by the
linearization rule in Section 3.

### I15. Boundedness invariant

Review attempts, aggregate review time, input size, denial history, and queued
work are bounded. No configuration lock is held across model or tool I/O. Subject
to OS/provider scheduler progress, the extension cannot deadlock or retry forever.

### I16. Denial-loop invariant

Three consecutive permission denials, or ten denials in the latest fifty guarded
Auto decisions in one active permission runtime and turn, interrupt the turn.
Any admitted Auto decision resets the consecutive count. Interruption remains
sticky until turn end. Catastrophic pre-runtime initialization failure has no
Guardian state to count against; its gates still deny every call and the
extension itself performs no retry.

### I17. Honest-status invariant

The extension never labels ReviewOnly as sandboxed and never treats a failed
macOS/Linux sandbox as ReviewOnly or Unrestricted. Unsupported-platform fallback
and supported-platform failure are reported non-interactively and distinctly.
Catastrophic engine construction is separately labeled `Auto (unavailable)` and
does not expose a functioning command host.

## 6. Proof sketches

### Theorem A: no denied reviewed action executes

By inspection of the lifecycle graph, `Executed` has only `Admitted` as a
predecessor. The review branch reaches `Admitted` only when every predicate in
Section 3 is true. `deny` and every failure class transition to terminal `Denied`.
There is no edge from `Denied` to `Admitted`; therefore a denied reviewed action
cannot execute.

### Theorem B: Auto never silently broadens to host shell access

Exhaust the backend cases. Under `Sandboxed`, every default-permission command is
spawned only by the sandbox runner; dangerous commands require an allow without
losing containment, and only an explicit escalation can reach the local runner
after an allow. Under `ReviewOnly`, every command requires an allow before spawn. Under
`Unavailable`, and for unknown backend state, shell execution is denied. These
are exhaustive, so no Auto branch starts an unreviewed unsandboxed shell.

### Theorem C: an Unrestricted parent cannot create an Unrestricted child by
inheritance

Session initialization is the constant function `requestedMode := Auto`; it has
no parent-mode input. The base case holds for a direct child. Applying the same
function at each edge proves by induction that every finite descendant starts
with requested Auto.

### Theorem D: stale approval cannot execute

Every policy-relevant mutation increments a captured revision or changes the
captured backend/session lifecycle. Admission requires equality of all captured
and current values plus equality of the canonical request. Therefore any such
mutation falsifies at least one necessary predicate. Monotonic revision prevents
Auto -> Unrestricted -> Auto ABA from restoring validity.

### Theorem E: no approval dialog can occur

The admission state machine contains no Ask state or UI edge. Reviewer outcomes
outside exact allow all map to `Denied`. Only explicit slash-command handlers can
call selection UI, and model tool calls cannot dispatch those handlers. Therefore
action review cannot produce an approval dialog.

### Theorem F: the extension cannot create an infinite approval loop

Each review attempt and total review have finite deadlines and attempt bounds.
Each action has terminal states and is never internally replayed. Across model
actions in an active permission runtime, every guarded Auto denial—including
pre-review denials—feeds the finite denial circuit breaker. Catastrophic
pre-runtime failure has no review engine, but its outer gates only return denial
and never retry. Thus the extension itself has no infinite retry path.

### Theorem G: global Off is coherent across active processes

The global mutation is serialized and atomically committed before success is
reported. Each active gate reads global state. Every potentially admitting
review reads it before model I/O and, after an allow, after model I/O and once
more before final admission. Order a gate and the Off commit by the gate's
controlling successful read. A successful read after the commit observes
Disabled, while a read failure denies; a reviewed binding read after the commit
also differs from an old capture and denies. If the final controlling read and
admission precede the commit, the action may enter its executor once even if
scheduling makes that entry occur after the commit. Thus Off is coherent and
linearizable among active runtimes without the false stronger claim that it
revokes actions already admitted. In the separately modeled catastrophic state
there is no active gate capable of reading Off, so the outer interception layer
denies.

## 7. Explicit non-guarantees

The extension does not claim:

- that the review model always makes the correct risk judgment;
- containment of trusted third-party extension implementation code;
- protection from kernel, sandbox-runtime, provider, or Pi vulnerabilities;
- rollback of permitted partial effects from a sandboxed compound command;
- mediation of commands explicitly entered by the user;
- protection from a hostile local process racing filesystem operations;
- retroactive cancellation of an action already linearized for admission when a
  sibling process subsequently changes global policy;
- concurrent strong-sandbox ownership by multiple Pi sessions in one Node
  process, or recovery from a poisoned Sandbox Runtime reset without restarting
  that process.

These exclusions are necessary to make the positive guarantees precise rather
than aspirational.
