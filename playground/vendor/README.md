# vendor

`rhue-lsp` is the 2.2.0 release from crates.io with one change, in `src/uri.rs`: on plain wasm (`wasm32-unknown-unknown`) `url` can't turn file uris into paths, so it does it by hand there. Everything else is untouched.

Once a rhue release has that fix, delete this folder and the `[patch.crates-io]` in `../Cargo.toml`.
