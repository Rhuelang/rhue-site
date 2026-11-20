<div align="center">
  <img src="https://raw.githubusercontent.com/rhuelang/rhue/main/assets/Logo.svg" width="140" alt="Rhue logo">
  <h1>rhue-lsp</h1>
  <p>A language server for Rhue, over stdio.</p>
  <p>
    <a href="https://crates.io/crates/rhue-lsp"><img src="https://img.shields.io/crates/v/rhue-lsp?style=for-the-badge&amp;color=e07b4f" alt="rhue-lsp on crates.io"></a>
    <a href="https://github.com/rhuelang/rhue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rhuelang/rhue/ci.yml?branch=main&amp;style=for-the-badge&amp;label=ci" alt="CI status"></a>
    <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-1.88%2B-e07b4f?style=for-the-badge&amp;logo=rust" alt="Rust 1.88 or newer"></a>
    <a href="https://github.com/rhuelang/rhue#-license"><img src="https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-blue?style=for-the-badge" alt="MIT or Apache-2.0"></a>
  </p>
</div>

```bash
cargo install rhue-lsp
```

Point your editor's LSP client at `rhue-lsp` for `*.rhue` files. In Neovim:

```lua
vim.filetype.add({ extension = { rhue = "luau" } })
vim.lsp.config("rhue", { cmd = { "rhue-lsp" }, filetypes = { "luau" }, root_markers = { ".git" } })
vim.lsp.enable("rhue")
```

What you get:

- errors as you type, with quick fixes for typos (`pirnt` → `print`) and maybe-nil values
- hover types, and inlay hints for whatever the checker inferred (double-click one to write it in)
- go to definition and find references, across modules too (`require("geo.shapes").area` finds `function M.area`)
- rename for locals, refused if the new name would shadow something
- completion after `.` and `:`, plus names in scope
- signature help, document and workspace symbols, semantic highlighting
- formatting, through `rhue-fmt`

Files without a `--!strict` or `--!nonstrict` directive get checked non-strictly, so annotations still count. Modules resolve next to the file (`a.b` is `a/b.rhue` or `a/b/init.rhue`) and unsaved editor buffers win over what's on disk. Editing a module only re-checks the open files that require it.

## License

MIT or Apache-2.0, same as the rest of Rhue.
