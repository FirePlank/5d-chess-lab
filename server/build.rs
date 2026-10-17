// The engine commit this server is built with (Cargo.lock's pin of the `kairos` git
// dependency), for /api/info: games played here record which engine they were played against.
fn main() {
    let lock = concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.lock");
    println!("cargo:rerun-if-changed={lock}");
    let text = std::fs::read_to_string(lock).unwrap_or_default();
    let rev = text
        .split("[[package]]")
        .find(|p| p.contains("name = \"kairos\"\n"))
        .and_then(|p| p.lines().find_map(|l| l.trim().strip_prefix("source = \"")))
        .and_then(|s| s.trim_end_matches('"').rsplit_once('#').map(|(_, r)| r.to_string()))
        .unwrap_or_default();
    println!("cargo:rustc-env=KAIROS_ENGINE_REV={rev}");
}
