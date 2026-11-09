fn main() {
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../core/src");
    println!("cargo:rerun-if-changed=../Cargo.lock");
    println!("cargo:rerun-if-changed=src");
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_nanos();
    println!("cargo:rustc-env=EFN_BUILD_ID={id}");
    tauri_build::build()
}
