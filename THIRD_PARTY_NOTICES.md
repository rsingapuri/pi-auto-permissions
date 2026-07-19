# Third-party notices

## OpenAI Codex

Portions of the automatic-review policy and command-safety behavior are adapted
from [OpenAI Codex](https://github.com/openai/codex) at revision
`0fb559f0f6e231a88ac02ea002d3ecd248e2b515`.

Copyright 2025 OpenAI.

Licensed under the Apache License, Version 2.0. The repository root `LICENSE`
contains the license text. Adapted files carry a modification notice and retain
their exact upstream source path and revision.

This project changes Codex's denial recovery behavior: it removes human override
and user-approval paths, returning a terminal model-directed denial instead.

## Pi

The extension API integration follows examples and public interfaces from
[Pi](https://github.com/earendil-works/pi) at revision
`3da591ab74ab9ab407e72ed882600b2c851fae21`.

Copyright (c) 2025 Mario Zechner.

Pi is licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Anthropic Sandbox Runtime

Shell containment uses
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
`0.0.65`, licensed under the Apache License, Version 2.0. It is an exact-version
pinned external dependency and is not copied into this repository.

## Tree-sitter and Tree-sitter Bash

Codex-compatible shell parsing uses `web-tree-sitter` `0.25.10` and the
`tree-sitter-bash` `0.25.1` WebAssembly grammar. Both are distributed under the
MIT License. The grammar is from the same Tree-sitter Bash 0.25 series used by
the referenced Codex revision; native install scripts are not required or
executed.

`tree-sitter-bash` is Copyright (c) 2017 Max Brunsfeld.

`web-tree-sitter` is Copyright (c) 2018-2024 Max Brunsfeld.

## proper-lockfile

Atomic cross-process configuration locking uses `proper-lockfile` `4.1.2`,
Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>, distributed under
the MIT License. It is an exact-version pinned external dependency and is not
copied into this repository.
