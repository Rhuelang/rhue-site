// which rhue Cargo.lock picked, so the playground can say what it's running
fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").unwrap_or_default();
    let version = lock
        .split("[[package]]")
        .find(|p| p.contains("\nname = \"rhue\"\n"))
        .and_then(|p| p.lines().find_map(|l| l.strip_prefix("version = \"")))
        .map(|v| v.trim_end_matches('"').to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=RHUE_VERSION={version}");
}
