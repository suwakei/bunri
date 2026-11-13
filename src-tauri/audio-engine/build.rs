//! sfizz (third_party/sfizz、git submodule) を cmake で静的ライブラリとしてビルドし、リンクする。
//!
//! sfizz 本体だけを作る (プラグイン・JACK・SMF の描画・LTO は切る)。依存 (abseil など) も
//! sfizz の submodule にあるものを使い、システムのライブラリには頼らない。
//!
//! sfizz には bunri で直した不具合がある (下の `PATCHES`)。submodule は本家のまま置き、
//! ビルドのたびにソースを `OUT_DIR` へ写してから直す。直す前の文字列が見つからなければ
//! ビルドを止める (sfizz を更新したときに、直しが黙って外れないように)。
use std::path::{Path, PathBuf};
use std::{env, fs};

/// (ファイル, 直す前, 直した後, 理由)
const PATCHES: &[(&str, &str, &str, &str)] = &[(
    "src/sfizz/FilePool.cpp",
    "void sfz::FilePool::waitForBackgroundLoading() noexcept
{
    std::lock_guard<std::mutex> guard { loadingJobsMutex };

    for (auto& job : loadingJobs)",
    "void sfz::FilePool::waitForBackgroundLoading() noexcept
{
    std::lock_guard<std::mutex> guard { loadingJobsMutex };

    // bunri: dispatcher がまだ取り出していない依頼も、ここでジョブにしてから待つ
    QueuedFileData queuedData;
    while (filesToLoad->try_pop(queuedData)) {
        if (!queuedData.id.expired())
            loadingJobs.push_back(
                threadPool->enqueue([this](const QueuedFileData& data) { loadingJob(data); }, std::move(queuedData)));
    }

    for (auto& job : loadingJobs)",
    "オフライン描画 (freewheeling) で、ノートを鳴らした直後の読み込みを待ち損ねることがある。\
     読み込みの依頼はキューに積まれ、別スレッド (dispatcher) が取り出してからジョブになるが、\
     待つ処理はジョブしか見ないため、取り出される前だと素通りする。\
     データが足りなくなった声はそこで終わるので、書き出しで音の続きが無音になる。\
     コードを読んで見つけたもので、手元では再現していない (待つ処理はブロックごとに走り、\
     サンプルの頭を鳴らしているあいだに取り出されれば間に合うため)。\
     dispatcher が頭の長さぶん以上遅れたときにだけ起きる、稀で追いにくい不具合なので直しておく",
), (
    "src/sfizz/Voice.cpp",
    "        impl.age_ = min(impl.age_ - *impl.triggerDelay_, 0);",
    "        // bunri: min では常に 0 になる (鳴り始めてからのフレーム数なので、下限を 0 にする)
        impl.age_ = max(impl.age_ - *impl.triggerDelay_, 0);",
    "声が鳴り始めて最初のブロックの境目で、サンプルが 1 フレームぶん止まる (同じ値が 2 回出て、\
     そのあとの音が 1 フレーム遅れる)。声の年齢 (鳴り始めてからのフレーム数) を、最初のブロックの\
     終わりで min(…, 0) にしているため 0 のままになり、次のブロックも「鳴り始め」として扱われて、\
     読む位置が進まない。止まる場所がブロックの区切り方で変わるので、再生 (音声デバイスの\
     バッファ) と書き出しで音がわずかに食い違う。テスト「processに渡す長さを変えても同じ音になる」が\
     確かめる (直しを外すと落ちる)",
)];

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let upstream = manifest.join("../../third_party/sfizz");
    if !upstream.join("CMakeLists.txt").exists() {
        panic!(
            "sfizz のソースが無い: {}\n`git submodule update --init --recursive` を実行してください",
            upstream.display()
        );
    }
    println!("cargo:rerun-if-changed=build.rs");
    for f in ["CMakeLists.txt", "src/sfizz.h"] {
        println!("cargo:rerun-if-changed={}", upstream.join(f).display());
    }
    for (file, ..) in PATCHES {
        println!("cargo:rerun-if-changed={}", upstream.join(file).display());
    }

    // このスクリプトが走り直すのは、build.rs か sfizz が変わったときだけ。そのときは cmake の
    // 作業場所ごと作り直す (写したファイルは元の更新時刻を引き継ぐので、直しを外したときに
    // make が古いオブジェクトを使い続けてしまう)
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let src = out.join("sfizz-src");
    for dir in [&src, &out.join("build")] {
        if dir.exists() {
            fs::remove_dir_all(dir).unwrap();
        }
    }
    copy_tree(&upstream, &src);
    for (file, before, after, why) in PATCHES {
        let path = src.join(file);
        let text = fs::read_to_string(&path).unwrap();
        if !text.contains(before) {
            panic!(
                "sfizz の {file} に、直す前の文字列が見つからない。sfizz を更新したなら、\
                 直しがまだ要るか確かめて build.rs の PATCHES を合わせてください。\n理由: {why}"
            );
        }
        fs::write(&path, text.replacen(before, after, 1)).unwrap();
    }

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

/// `from` の中身を `to` に写す (`.git` は除く)。
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(&name));
        let ty = entry.file_type().unwrap();
        if ty.is_dir() {
            copy_tree(&src, &dst);
        } else if ty.is_symlink() {
            let target = fs::read_link(&src).unwrap();
            std::os::unix::fs::symlink(target, &dst).unwrap();
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}
