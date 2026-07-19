# Vendored OpenAI Codex material

These files are copied verbatim from OpenAI Codex revision
`0fb559f0f6e231a88ac02ea002d3ecd248e2b515` under Apache-2.0:

- `guardian/policy.md` from `codex-rs/core/src/guardian/policy.md`
  (`sha256:c2be313e18e1af6f1fce400db338cb9895d3f21cb9f5e31cccb36af02a8e36e6`)
- `guardian/policy_template.md` from
  `codex-rs/core/src/guardian/policy_template.md`
  (`sha256:f41c5bd2900de074a75464fa0c5e73a64e528a9402b9f4b2d511db231becadd2`)
- `NOTICE` from the repository root
  (`sha256:9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915`)

The runtime does not assemble these vendored policy documents into its model
prompt. They remain provenance for the Guardian design and pinned dangerous-shell
behavior. Pi's shell-only reviewer instead receives one concise severe-harm
instruction; that deliberate divergence is identified in the generated prompt
source.
