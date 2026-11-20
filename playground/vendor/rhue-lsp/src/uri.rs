//! lsp-types moved to its own `Uri`, which doesn't know about files. These go
//! between it and paths through `url`, which does (drive letters and all).

use std::path::{Path, PathBuf};

use lsp_types::Uri;
use url::Url;

#[expect(
    clippy::result_unit_err,
    reason = "the same shape as url's own to_file_path"
)]
pub trait UriExt {
    /// The file a `file://` URI points at.
    fn to_file_path(&self) -> Result<PathBuf, ()>;
}

impl UriExt for Uri {
    fn to_file_path(&self) -> Result<PathBuf, ()> {
        let url = Url::parse(self.as_str()).map_err(|_| ())?;
        file_path(&url)
    }
}

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
fn file_path(url: &Url) -> Result<PathBuf, ()> {
    url.to_file_path()
}

// url only does file paths where there's a real filesystem. plain wasm has none,
// but paths still work as names (the playground keeps its files in memory), so
// treat them like unix ones
#[cfg(all(target_family = "wasm", target_os = "unknown"))]
fn file_path(url: &Url) -> Result<PathBuf, ()> {
    if url.scheme() != "file" || url.host_str().is_some_and(|h| !h.is_empty()) {
        return Err(());
    }
    let path = percent_encoding::percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| ())?;
    Ok(PathBuf::from(path.into_owned()))
}

/// A `file://` URI for an absolute path.
#[expect(
    clippy::result_unit_err,
    reason = "the same shape as url's own from_file_path"
)]
pub fn from_file_path(path: impl AsRef<Path>) -> Result<Uri, ()> {
    file_url(path.as_ref())?.as_str().parse().map_err(|_| ())
}

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
fn file_url(path: &Path) -> Result<Url, ()> {
    Url::from_file_path(path)
}

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
fn file_url(path: &Path) -> Result<Url, ()> {
    let path = path.to_str().ok_or(())?;
    if !path.starts_with('/') {
        return Err(());
    }
    let mut url = Url::parse("file:///").map_err(|_| ())?;
    url.set_path(path);
    Ok(url)
}
