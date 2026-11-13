//! sfizz (third_party/sfizz、git submodule) を cmake で静的ライブラリとしてビルドし、リンクする。
//!
//! sfizz 本体だけを作る (プラグイン・JACK・SMF の描画・LTO は切る)。依存 (abseil など) も
//! sfizz の submodule にあるものを使い、システムのライブラリには頼らない。
use std::path::PathBuf;
use std::{env, fs};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("../../third_party/sfizz");
    if !src.join("CMakeLists.txt").exists() {
        panic!(
            "sfizz のソースが無い: {}\n`git submodule update --init --recursive` を実行してください",
            src.display()
        );
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!(
        "cargo:rerun-if-changed={}",
        src.join("src/sfizz.h").display()
    );

    let dst = cmake::Config::new(&src)
        .profile("Release")
        .define("SFIZZ_SHARED", "OFF")
        .define("SFIZZ_RENDER", "OFF")
        .define("SFIZZ_JACK", "OFF")
        .define("ENABLE_LTO", "OFF")
        .define("SFIZZ_GIT_SUBMODULE_CHECK", "OFF")
        // sfizz が抱える古い atomic_queue が、clang 19 以降で既定のエラーになる書き方をしている。
        // コードの誤りではないので警告に戻す
        .cxxflag("-Wno-missing-template-arg-list-after-template-kw")
        .build_target("sfizz_static")
        .build();

    // sfizz は依存ごとに静的ライブラリを分けて作る。出来たものをすべてリンクする
    // (macOS の ld はアーカイブの順に依らず解決する)
    let lib_dir = dst.join("build/library/lib");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    let mut libs: Vec<String> = fs::read_dir(&lib_dir)
        .unwrap_or_else(|e| panic!("{} を読めない: {e}", lib_dir.display()))
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            Some(name.strip_prefix("lib")?.strip_suffix(".a")?.to_string())
        })
        .collect();
    libs.sort();
    for lib in libs {
        println!("cargo:rustc-link-lib=static={lib}");
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    if target_os == "macos" {
        println!("cargo:rustc-link-lib=c++");
        for fw in ["CoreFoundation", "Foundation", "Accelerate"] {
            println!("cargo:rustc-link-lib=framework={fw}");
        }
    } else {
        println!("cargo:rustc-link-lib=stdc++");
    }
}
