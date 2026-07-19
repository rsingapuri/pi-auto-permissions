# pi-auto-permissions

`pi-auto-permissions` is a small, background permission guardrail for
[Pi](https://github.com/earendil-works/pi). It has exactly two selectable modes:
**Auto** and **Unrestricted**. Auto combines static rules, a Codex-inspired
model reviewer, and an OS shell sandbox; Unrestricted stays available for the
occasional session where the user deliberately wants no guardrail.

There is no Ask mode, per-action confirmation prompt, approval file, or command
catalog to maintain. A denied model action is not shown as a user approval
dialog. The model receives this terminal result instead:

```text
Permission denied. This action was not executed. No override will be requested. Choose a materially safer action.
```

The model cannot appeal that result inside the action. It must issue a new,
materially safer action. The user also receives a passive warning notice naming
the denied tool; it never asks for approval. The user can still deliberately
change the session's mode with `/perm`.

## Requirements and installation

- Pi `0.80.10`
- Node.js `22.19.0` or newer
- macOS or Linux for the strong shell sandbox
- On Linux, the Sandbox Runtime's `bubblewrap` (`bwrap`), `socat`, and
  `ripgrep` (`rg`) dependencies, plus its supported seccomp helper

From a checked-out copy, install dependencies and register the package globally
with Pi:

```sh
npm ci
pi install /absolute/path/to/pi-auto-permissions
```

Use `pi install /absolute/path/to/pi-auto-permissions -l` for a project-local Pi
package instead. During development, it can be loaded for one run:

```sh
npm ci
pi -e ./src/extension.ts
```

The extension stores one private, machine-global permission record plus primary
and recovery copies of an internal monotonic revision watermark under Pi's agent
directory. Its only semantic settings are the enabled flag and reviewer tuple;
schema/revision bookkeeping is internal, model credentials continue to be
resolved by Pi, and credentials are never stored by this extension. There is
intentionally no user-managed permission configuration file.

## First use

Auto is unavailable until its complete reviewer tuple has been selected. Until
then, Unrestricted is the only effective mode and is shown as `Unrestricted`.
Select an exact Pi model and an explicit thinking level:

```text
/perm-auto-model provider/model thinkingLevel
```

For example:

```text
/perm-auto-model openai/gpt-5.2 high
```

The example is illustrative; the provider, model, credentials, and thinking
level must exist in the current Pi installation. Supported thinking-level
values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but
each model may expose only a subset. The command validates availability,
authentication, and support for that exact level before atomically saving
`(provider, model, thinkingLevel)`.

In an interactive Pi session, `/perm-auto-model` with no arguments opens a
model picker followed by a picker containing only that model's supported
thinking levels. A successful selection also puts the current session in Auto.
It does not change the main conversation model or its thinking level.

## Commands

| Command | Effect |
| --- | --- |
| `/perm auto` | Select Auto for this session. Rejected without a valid reviewer tuple. |
| `/perm unrestricted` | Select Unrestricted for this session. |
| `/perm` | Open the two-item Auto/Unrestricted picker in an interactive session. |
| `/perm-auto-model provider/model thinkingLevel` | Atomically select the global Auto reviewer tuple and put this session in Auto. |
| `/perm-auto-model` | Interactively pick the reviewer and its thinking level. |
| `/perm-enabled off` | Disable the extension's enforcement globally, including for existing and future sessions. |
| `/perm-enabled on` | Re-enable global enforcement. Sessions then use their own requested mode. |

`/perm-enabled` is an enable switch, not a third mode. Backends such as
review-only are implementation states and never appear in `/perm`.

Status is deliberately terse:

- `Auto` — strong shell sandbox initialized and Auto is active.
- `Auto (review-only)` — this OS is unsupported, so every model-originated
  shell call is reviewed before any unsandboxed process can start.
- `Auto (sandbox unavailable)` — macOS/Linux sandbox setup/runtime failed or
  another same-process session owns Sandbox Runtime; Auto shell calls fail
  closed.
- `Auto (unavailable)` — catastrophic permission-engine construction failed;
  all model tool gates deny and the extension's commands cannot mutate state
  until a later successful session initialization (normally reload or process
  restart).
- `Unrestricted` — explicitly selected, or Auto is not yet configured.
- `Off` — enforcement is globally disabled.

In an Auto-requested session, invalid durable state is reported as
`Auto (configuration fault)` and guarded actions fail closed. Explicit
Unrestricted remains a deliberate bypass. The management commands remain
available to attempt an explicit repair; repair refuses if neither private
revision watermark is valid enough to prove a monotonic next revision.

`Auto (unavailable)` is a narrower catastrophic construction state, not a
normal mode or backend. No engine exists there to consult even a previously
durable Off setting, so the outer gates deny rather than assuming a bypass.

## Session semantics

Every new, resumed, forked, cloned, or independently spawned Pi runtime starts
with requested mode Auto. In particular, an Unrestricted parent cannot confer
Unrestricted on a child process or subagent. If the reviewer has not been
selected yet, that default Auto intent becomes effective only after a reviewer
tuple exists.

`/reload` is the sole exception: it restores the requested mode of that same
logical runtime. Switching to another session or starting a child does not copy
that checkpoint. The global enabled flag and reviewer tuple are reread at tool
gates, so `/perm-enabled off`, `/perm-enabled on`, and reviewer changes also
affect already-running Pi processes. A same-runtime command actively cancels
that runtime's pending reviews. A sibling-process change cannot push an abort
signal across processes; it is detected at the next pre-model, post-model, or
final binding read and makes the old review stale.

Permission admission is the policy linearization point. If a sibling commits a
change before an action's controlling state read, the action uses the new state.
An action already finally admitted before the commit may still enter its
executor once; global Off is intentionally not a retroactive process-kill
switch.

## What Auto does

Auto classifies the final Pi tool call visible to this extension:

| Action | Auto behavior |
| --- | --- |
| Pi built-in or trusted SDK-backed `read`, `grep`, `find`, `ls` | Statically admitted. |
| Pi built-in or trusted SDK-backed `write` and `edit` | Admitted without model review after deterministic path classification. |
| Trusted standard `write` and `edit` targeting this extension's state/lock paths | Statically denied in Auto without model review. |
| Ordinary `bash` on healthy macOS/Linux | Runs once in the fixed OS sandbox. |
| Codex-dangerous `bash` with the default sandbox permission | Reviewed; an exact allow runs once inside the fixed sandbox. |
| A `bash` call with `sandbox_permissions: "require_escalated"` | Reviewed; an exact allow runs once with normal host permissions. |
| Any `bash` on an unsupported OS (including WSL1) | Reviewed; an exact allow runs once with normal host permissions. |
| Any `bash` after a supported macOS/Linux sandbox failure | Denied before review or process creation. |
| Third-party/custom tool | Admitted as a user-installed trusted implementation; never sent to Guardian. |

Static mutation classification resolves existing symlinks and the nearest
existing ancestor of a new path so the extension can protect its own state and
lock paths without model review. Other trusted direct-file targets pass through.
The sandbox allows broad filesystem reads,
writes only to the workspace and temporary roots, keeps protected metadata and
the extension's durable state read-only, denies network and local binding, and
applies to descendant processes.

If direct-file path policy construction fails at startup, the fallback admits
only the four known read-only standard tools and statically denies every `write` or
`edit`. It does not guess path safety or ask the reviewer to replace missing
classification.

Only reviewed shell actions reach the reviewer. Its complete semantic policy is:

> Call deny only when the exact command is clearly likely to cause severe,
> difficult-to-reverse harm: broad loss of important data, disclosure of secrets
> or private data to an untrusted destination, major shared or production service
> disruption, or persistent broad security weakening. Otherwise call approve.

No JSON schema, taxonomy, tenant policy, authorization rubric, or output-contract
preamble is sent to the model. The user payload is only the exact canonical
shell action; no conversation transcript, retry rationale, or session metadata
is sent. The reviewer has fixed read-only `read`, literal `grep`, `find`, and
`ls` tools plus final `approve` and `deny` decision tools. Investigation is
bounded to four rounds and eight calls cumulatively across all retry attempts.
Text answers, missing decisions, multiple decisions, and decision calls mixed
with investigation calls are re-prompted up to twice; only one valid decision
tool call is accepted. The adapter converts that structured call into a local
one-field verdict. Exhausted re-prompts, timeouts, missing credentials, provider
errors, cancellation, state changes, and every other non-allow outcome deny.
Reviews have one aggregate 90-second deadline, at most three retryable model
attempts, and denial circuit breakers to prevent loops. The model always sees
one fixed denial message, while the user notification identifies whether the
reviewer actually called `deny` or failed for a protocol/runtime reason.

A sandbox rejection is returned as an ordinary tool error. The extension does
not replay a command that may have started. The model may issue a different
command or a new exact `require_escalated` request, which is reviewed without
opening a user dialog.

The shell fallback matches the pinned Codex default Auto preset
(`OnRequest + AutoReview + workspace`) without custom exec-policy rules or
experimental permission features. Codex's optional rule files, managed-network
flow, and additional-permission features are intentionally not reproduced.

## Platform behavior

On macOS and Linux, startup performs dependency checks, initializes
`@anthropic-ai/sandbox-runtime`, and runs an actual contained `true` process.
Only a successful probe enables sandboxed shell execution. On Linux, missing
`bwrap`, `socat`, or strong seccomp/Unix-socket isolation is a sandbox failure.

Sandbox Runtime owns process-global policy, so a supported-host Node process has
one active strong-sandbox controller at a time. If another Pi session in that
same process starts concurrently, its backend is reported as sandbox unavailable
and its Auto shell calls deny; it never replaces or shares the first session's
workspace policy. Unsupported-host ReviewOnly sessions do not claim this owner.
The owner is released only after commands drain and reset succeeds. A failed
final reset poisons strong-sandbox reuse until that Node process restarts, which
prevents a later session from inheriting stale policy.

An unsupported OS uses the visibly labeled review-only fallback. Review-only is
functional but is not equivalent to containment: an allowed shell command has
the user's normal host permissions. By contrast, a dependency,
initialization, probe, or runtime failure on supported macOS/Linux never
silently downgrades to review-only. It reduces availability and reports
`Auto (sandbox unavailable)`.

## Trust boundary and limitations

This is a practical coding-agent guardrail, not a proof that model-approved
actions are safe. Its formal routing and state guarantees are documented in
[`docs/invariants.md`](docs/invariants.md), with the proof-linked construction
in [`docs/implementation-plan.md`](docs/implementation-plan.md). Important
limits are:

- A reviewer model is probabilistic and can make a wrong allow decision.
- Sandboxed shell commands and the reviewer's bounded investigation tools have
  broad read access. Read evidence is sent to the selected reviewer provider;
  this extension is not a general secret-reading boundary.
- Reviewed escalated shell commands execute without OS containment after an
  allow.
- Direct-file and third-party tool implementations, SDK host tools, and other
  loaded Pi extensions are trusted.
  They can have surprising effects, and this extension cannot sandbox their
  implementation or stop a later extension from deliberately bypassing it.
- Pi's user-entered `!` and `!!` shell commands are explicit user actions and
  are outside this model-action guardrail.
- Unrestricted and global Off intentionally bypass review and sandboxing.
- Kernel, Pi, Sandbox Runtime, provider, filesystem, and hostile local-process
  bugs or subversion are outside the guarantee. Static paths resist ordinary
  symlink indirection but do not claim to defeat a hostile local TOCTOU race.
- A compound sandboxed command can complete permitted effects before a later
  operation is rejected. The extension never automatically retries it.
- On an unsupported OS, review-only provides model review, not process
  isolation. On supported macOS/Linux, failed containment instead fails closed.
- Concurrent supported-host sessions in one Node process cannot each own a
  different strong Sandbox Runtime policy. Additional sessions fail closed for
  Auto shell until the owner closes successfully; reset failure requires a
  process restart.
- Global policy changes do not retroactively kill actions already admitted at
  their final permission check.
- A catastrophic permission-engine initialization failure denies all model tool
  calls, but its slash-command host is unavailable until Pi successfully starts
  the extension again.

## Testing

Run the deterministic suite from a clean install:

```sh
npm ci
npm run check
npm run pack:check
```

Most sandbox lifecycle coverage uses controlled adapters, while the real OS
sandbox test stays gated. On a disposable macOS/Linux CI host with the native
prerequisites installed, opt in to the real process-boundary test:

```sh
npm run test:real-sandbox
```

That gate starts actual descendant shells and verifies workspace and temporary
writes, protected/outside/extension-state rejection, symlink and substitution
escapes, a Node-interpreter escape attempt, local TCP denial, and a workspace
that differs from the Node process cwd. Controlled controller tests cover
dependency/probe/runtime failures, ownership and reset poison, shutdown drain,
and no replay after ambiguous execution failure. The rest of the deterministic
suite covers the effective-mode truth table, state durability and process races,
path and symlink cases, pinned Codex dangerous-command cases, strict review
verdicts, deadlines and cancellation, stale bindings, commands, public
ExtensionRunner/ResourceLoader integration, two real print-mode `AgentSession`
flows, lack of action-review dialogs, the explicit traceability manifest, and
provenance hashes. The manifest maps every invariant to a named test file/title
witness and fails if that witness disappears. The suite does not claim packaged
CLI, live TUI, RPC, or JSON-mode coverage.

## License and attribution

This project is licensed under the
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- The Guardian policy and dangerous-command behavior are adapted from
  [OpenAI Codex revision `0fb559f0f6e231a88ac02ea002d3ecd248e2b515`](https://github.com/openai/codex/tree/0fb559f0f6e231a88ac02ea002d3ecd248e2b515),
  Apache-2.0. The exact upstream Guardian files and notice are vendored with
  recorded SHA-256 hashes in
  [`vendor/openai-codex/README.md`](vendor/openai-codex/README.md); derivative
  source files identify their modifications.
- Pi integration targets `@earendil-works/pi-coding-agent` `0.80.10` at
  [revision `3da591ab74ab9ab407e72ed882600b2c851fae21`](https://github.com/earendil-works/pi/tree/3da591ab74ab9ab407e72ed882600b2c851fae21),
  MIT.
- Shell containment uses `@anthropic-ai/sandbox-runtime` `0.0.65`,
  Apache-2.0.
- Portable Codex-compatible shell parsing uses `web-tree-sitter` `0.25.10`
  and `tree-sitter-bash` `0.25.1`, both MIT.
- Atomic cross-process state locking uses `proper-lockfile` `4.1.2`, MIT.

Runtime dependencies and the Pi development target are exact-version pinned in
`package.json` and `package-lock.json`; the provenance unit test verifies those
pins, upstream revisions, licenses, notices, and vendored hashes offline.
