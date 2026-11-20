//! Rhue for the playground on rhue.dev: the language server's features and an
//! engine you can run, debug and profile, built for `wasm32-unknown-unknown`.
//! The page runs it in web workers, see `src/playground` in the site.

mod convert;
mod lang;
mod pretty;
mod run;
mod text;

pub use lang::{Lang, rhue_version, token_legend};
pub use run::{configure, eval, run};
