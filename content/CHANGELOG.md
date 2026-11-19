# Changelog

All notable changes to Rhue. The project was built in milestones; until the
first release they're all part of 0.1.0. [`docs/DESIGN.md`](docs/DESIGN.md)
explains the decisions behind each one, and the README has the measurements.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions will follow [Semantic Versioning](https://semver.org/) once
published. Only the `rhue` crate's API is meant to be stable; the other
crates are its implementation.

## [0.1.0] - Unreleased

### Async hosts (milestone 25)

- Feat: Async Rust functions scripts can call and wait on (`register_async`). An `Err` gets raised where the script called it.
- Feat: `eval_async`, `call_async` and `run_until_idle` to run those scripts. Dropping the future cancels the script.
- Feat: `task.wait` and `task.delay` run on real time under the async drivers, through whatever sleep function the host passes to `set_sleep`.
- Feat: `interrupt_handle()` stops a running or waiting script from any thread. Doesn't cost anything until the instruction budget's slice runs out.
- Feat: `Error::is_interrupted`, and the `async_host` example on tokio.

### Release readiness (milestone 24)

- Continuous integration on GitHub Actions: build and tests on Linux, macOS
  and Windows, the examples, the benchmark scripts' expected results,
  `rustfmt`, clippy with warnings denied, docs with warnings denied, a build
  on the minimum Rust version, and `cargo package` for every crate.
- Crate metadata for crates.io (descriptions, keywords, categories, versioned
  internal dependencies) and the `LICENSE-MIT` and `LICENSE-APACHE` files the
  license field already named.
- Every public item of the `rhue` crate is documented (`missing_docs` is now
  a warning there), with runnable examples for sandboxing, modules and
  compiled chunks, and tasks.
- Examples: `hello`, `sandbox`, `modules` and `tasks`, alongside `embed`.
- `.gitattributes` keeps line endings LF on every platform.

### Changed

- The minimum supported Rust version is 1.88, not 1.85: the code uses let
  chains, which became stable in 1.88. CI now checks it.

### Performance IV: calls (milestone 23)

- Cheaper Lua calls and returns.
- Fast paths for common builtins (`type`, `setmetatable`, `rawget`, `math.*`,
  `string.len`/`byte`/`sub`, the `pairs` and `ipairs` iterators). They belong
  to the function value, so a script that shadows a builtin calls its own.
- Coroutine switches that allocate nothing and swap state in place.
- `rhue_vm::Native` has a new public field, `fast`.

### Performance III (milestone 22)

- Table templates (`DUPTABLE`): constructors with constant keys make their
  tables with the keys in place.
- `table.move`, and a `table.create` that fills in one step.
- The `arrays` benchmark. Saved chunks are format 4 (older ones still load).

### Tooling III (milestone 21)

- An interactive REPL: multi-line input, history, readable tables, `:type`.
- `rhue test`, a test runner with Jest-style `expect` matchers.

### Vectors (milestone 20)

- Luau's `vector` value, its arithmetic, the `vector` library and a `vector`
  type, with `[f32; 3]` conversions for natives.

### Embedding II (milestone 19)

- Natives that suspend the script (`Engine::spawn`, `resume`), a host-driven
  `task` library, environments with their own globals, and `serde`
  conversions behind a feature flag.

### Standard library II (milestone 18)

- `bit32`, `buffer` (a new value type), `table.freeze`/`isfrozen`/`clone`,
  and `debug.traceback`/`debug.info`.

### Editor II (milestone 17)

- Inlay hints, document and workspace symbols, semantic tokens, quick fixes,
  and navigation across modules in `rhue-lsp`.

### Types II (milestone 16)

- Fields that methods add to `self`, read-only and write-only properties,
  flow typing through loops, and exact recursive types in saved chunks.

### Performance II (milestone 15)

- Constant tables cached per prototype, cheaper upvalues, a linear-time
  checker on long functions, and comparisons with Luau and Rhai.

### Types that travel (milestone 14)

- Generic type packs and defaults, flow typing of `local x` declared without
  a value, and types saved with chunks and module exports.

### Saved chunks and incremental tooling (milestone 13)

- Serialized bytecode (loaded without parsing, gated by the verifier),
  incremental re-analysis in the language server, conditional breakpoints,
  logpoints and expression evaluation in the debugger.

### Debugging (milestone 12)

- A host debug API (hooks, breakpoints, inspecting suspended frames) and a
  Debug Adapter Protocol server; rename and signature help in the language
  server.

### Tooling (milestone 11)

- `rhue-lsp` (diagnostics, hover, definition, references, completion,
  formatting) and `rhue fmt`.

### Patterns and modules (milestone 10)

- Lua patterns, `utf8`, a sandbox-safe `os`, and `require` with
  host-provided, typed modules.

### Coroutines (milestone 9)

- Coroutines (yielding across `pcall` and metamethods, host resume),
  metamethods in the dispatch loop, typed `self` in class methods.

### Language completeness (milestone 8)

- String interpolation, metatables and typed `setmetatable` classes, tail
  calls, and a memory limit.

### Performance and the verifier (milestone 7)

- A faster interpreter (inline caches, fused comparisons, small hash parts)
  and a bytecode verifier every chunk passes before it runs.

### Type checker (milestone 6)

- Luau type syntax, `--!strict`/`--!nonstrict`, narrowing, generics, and
  typed host declarations.

### Embedding (milestone 5)

- Typed `register`, calling scripts from Rust, re-entrant natives, and
  `#[derive(UserData)]`.

### Tables and the collector (milestone 4)

- Tables, methods, generic `for`, `pcall`, a mark-and-sweep collector, and
  the `table`, `string` and `math` libraries.

### Functions (milestone 3)

- Functions, multiple returns, varargs, closures and upvalues, the standard
  library's core, and tracebacks.

### Statements (milestone 2)

- Locals, assignment, comparisons, `and`/`or`, control flow, strings,
  globals, and the resolver.

### Expressions (milestone 1)

- Arithmetic expressions compiled to bytecode and run by the VM.
