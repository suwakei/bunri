//! 決められた music フォルダの音声だけを一覧にし、取り込み用に読む。

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Serialize)]
pub struct MusicEntry {
    name: String,
}

fn supported(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "wav" | "mp3" | "flac" | "ogg" | "m4a" | "aac" | "aif" | "aiff"
            )
        })
}

/// macOS の配布物では、署名された .app の外にある music を使う。
#[cfg(any(not(debug_assertions), test))]
fn beside_executable(executable: &Path) -> Result<PathBuf, String> {
    let base = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .unwrap_or(executable);
    base.parent()
        .map(|parent| parent.join("music"))
        .ok_or_else(|| "music フォルダの場所を確認できません".to_string())
}

fn music_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("music フォルダの場所を確認できません")?
            .join("music"))
    }
    #[cfg(not(debug_assertions))]
    {
        let executable = std::env::current_exe()
            .map_err(|error| format!("music フォルダの場所を確認できません: {error}"))?;
        beside_executable(&executable)
    }
}

/// フォルダ自体をリンクに差し替えて外を読ませることも許さない。
fn check_directory(dir: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err("music は通常のフォルダにしてください".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("music フォルダを確認できません: {error}")),
    }
}

fn list(dir: &Path) -> Result<Vec<MusicEntry>, String> {
    if !check_directory(dir)? {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(dir).map_err(|error| format!("music の曲一覧を読み込めません: {error}"))?
    {
        let entry = entry.map_err(|error| format!("music の曲一覧を読み込めません: {error}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with('.')
            && supported(&name)
            && entry
                .file_type()
                .map_err(|error| format!("music の曲を確認できません: {error}"))?
                .is_file()
        {
            entries.push(MusicEntry { name });
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn read(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || name.contains(['/', '\\'])
        || name.starts_with('.')
        || !supported(name)
    {
        return Err("music の曲一覧から音声ファイルを選んでください".to_string());
    }
    if !check_directory(dir)? {
        return Err("music フォルダがありません。一覧を読み直してください".to_string());
    }
    let path = dir.join(name);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("曲を読み込めません。一覧を読み直してください: {error}"))?;
    if !metadata.is_file() {
        return Err("通常の音声ファイルを選んでください（リンクは読み込めません）".to_string());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // 確認の直後にリンクや FIFO に替わっても、外を読んだり待ち続けたりしない。
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("曲を読み込めません: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| format!("曲を確認できません: {error}"))?
        .is_file()
    {
        return Err("通常の音声ファイルを選んでください".to_string());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("曲を読み込めません: {error}"))?;
    Ok(bytes)
}

#[tauri::command(async)]
pub fn music_list() -> Result<Vec<MusicEntry>, String> {
    list(&music_dir()?)
}

#[tauri::command(async)]
pub fn music_read(name: String) -> Result<tauri::ipc::Response, String> {
    read(&music_dir()?, &name).map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let mut random = [0u8; 8];
            getrandom::fill(&mut random).unwrap();
            let dir =
                std::env::temp_dir().join(format!("bunri-music-{:x}", u64::from_ne_bytes(random)));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn music_直下の音声だけを名前順で返して読み込む() {
        let fixture = Fixture::new();
        for name in ["七英雄.MP3", "a.wav", "memo.txt", ".hidden.mp3"] {
            fs::write(fixture.0.join(name), b"synthetic audio").unwrap();
        }
        fs::create_dir(fixture.0.join("nested.flac")).unwrap();
        let names: Vec<_> = list(&fixture.0)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["a.wav", "七英雄.MP3"]);
        assert_eq!(read(&fixture.0, "七英雄.MP3").unwrap(), b"synthetic audio");
        assert!(read(&fixture.0, "nested.flac").is_err());
        assert!(read(&fixture.0, "missing.mp3").is_err());
    }

    #[test]
    fn music_フォルダ無しは空一覧で不正な名前は読まない() {
        let fixture = Fixture::new();
        assert!(list(&fixture.0.join("missing")).unwrap().is_empty());
        for name in [
            "../outside.mp3",
            "/outside.mp3",
            "sub/song.mp3",
            "sub\\song.mp3",
            "memo.txt",
            ".hidden.mp3",
            "",
        ] {
            assert!(read(&fixture.0, name).is_err(), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn music_リンクを一覧にも読み込みにも使わない() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fs::write(fixture.0.join("source.wav"), b"synthetic audio").unwrap();
        symlink(fixture.0.join("source.wav"), fixture.0.join("link.mp3")).unwrap();
        assert_eq!(list(&fixture.0).unwrap().len(), 1);
        assert!(read(&fixture.0, "link.mp3").is_err());
        symlink(&fixture.0, fixture.0.join("linked-dir")).unwrap();
        assert!(list(&fixture.0.join("linked-dir")).is_err());
        assert!(read(&fixture.0.join("linked-dir"), "source.wav").is_err());
    }

    #[test]
    fn music_配布物ではアプリの外を参照する() {
        assert_eq!(
            beside_executable(Path::new("/Applications/bunri.app/Contents/MacOS/bunri")).unwrap(),
            Path::new("/Applications/music")
        );
        assert_eq!(
            beside_executable(Path::new("/opt/bunri/bunri")).unwrap(),
            Path::new("/opt/bunri/music")
        );
    }
}
