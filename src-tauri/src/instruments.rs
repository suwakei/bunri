//! 楽器の台帳から、導入が完了した SFZ の場所を引く。
//!
//! Python と同じ JSON をコンパイル時に読み込む。画面からファイルのパスは受け取らない。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

const CATALOG: &str = include_str!("../../backend/instrument_catalog.json");

#[derive(Deserialize)]
struct Catalog {
    packs: HashMap<String, Pack>,
    instruments: HashMap<String, Instrument>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pack {
    version: String,
    sha256: String,
    required_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Instrument {
    name: String,
    pack: String,
    sfz: String,
    one_shot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledInstrument {
    pub sfz: PathBuf,
    pub one_shot: bool,
}

pub fn unavailable(id: &str, reason: impl std::fmt::Display) -> String {
    format!("BUNRI_INSTRUMENT_UNAVAILABLE:{id}:{reason}")
}

fn catalog() -> Result<&'static Catalog, String> {
    static PARSED: OnceLock<Result<Catalog, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            serde_json::from_str(CATALOG).map_err(|e| format!("楽器の一覧を読めません: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 台帳の中でも、絶対パスや上位への移動を使わない。
fn relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// 既知で未導入なら `None`。不明な ID は、音色を置き換えずに理由を返す。
pub fn installed(id: &str, data_dir: Option<&Path>) -> Result<Option<InstalledInstrument>, String> {
    resolve(catalog()?, id, data_dir)
}

fn resolve(
    catalog: &Catalog,
    id: &str,
    data_dir: Option<&Path>,
) -> Result<Option<InstalledInstrument>, String> {
    let instrument = catalog
        .instruments
        .get(id)
        .ok_or_else(|| unavailable(id, "この楽器は一覧にありません。楽器を選び直してください"))?;
    let pack = catalog.packs.get(&instrument.pack).ok_or_else(|| {
        unavailable(
            id,
            "この楽器の素材が一覧にありません。楽器を選び直してください",
        )
    })?;
    if !relative(&instrument.pack)
        || !relative(&pack.version)
        || !relative(&instrument.sfz)
        || pack.required_paths.iter().any(|path| !relative(path))
    {
        return Err(unavailable(
            id,
            "楽器の一覧に使えない場所が指定されています",
        ));
    }
    let Some(data_dir) = data_dir else {
        return Ok(None);
    };
    let root = data_dir
        .join("instruments")
        .join(&instrument.pack)
        .join(&pack.version);
    let marker = std::fs::read(root.join(".installed.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let valid = marker.as_ref().is_some_and(|marker| {
        marker.get("version").and_then(|v| v.as_str()) == Some(pack.version.as_str())
            && marker.get("sha256").and_then(|v| v.as_str()) == Some(pack.sha256.as_str())
    });
    let sfz = root.join(&instrument.sfz);
    let complete = catalog
        .instruments
        .values()
        .filter(|i| i.pack == instrument.pack)
        .all(|i| relative(&i.sfz) && root.join(&i.sfz).is_file());
    if !valid
        || !complete
        || !sfz.is_file()
        || pack.required_paths.iter().any(|p| !root.join(p).exists())
    {
        return Ok(None);
    }
    Ok(Some(InstalledInstrument {
        sfz,
        one_shot: instrument.one_shot,
    }))
}

pub fn missing_message(id: &str) -> String {
    let name = catalog()
        .ok()
        .and_then(|c| c.instruments.get(id))
        .map(|i| i.name.as_str())
        .unwrap_or(id);
    unavailable(
        id,
        format!("「{name}」の音源がありません。楽器の欄からダウンロードしてください"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_catalog() -> Catalog {
        serde_json::from_str(r#"{
            "packs":{"test":{"version":"v1","sha256":"hash","requiredPaths":["Samples","LICENSE"]}},
            "instruments":{"piano":{"name":"ピアノ","pack":"test","sfz":"piano.sfz","oneShot":false},"drums":{"name":"ドラム","pack":"test","sfz":"kit.sfz","oneShot":true}}
        }"#).unwrap()
    }

    #[test]
    fn 不明な楽器は安定した印のついたエラーで未導入はなしになる() {
        let c = fixture_catalog();
        assert!(resolve(&c, "missing", None)
            .unwrap_err()
            .starts_with("BUNRI_INSTRUMENT_UNAVAILABLE:missing:"));
        assert_eq!(resolve(&c, "piano", None).unwrap(), None);
    }

    #[test]
    fn 同じ素材の複数の音色をそれぞれのsfzへ解決する() {
        let dir = std::env::temp_dir().join(format!("bunri-catalog-{}", std::process::id()));
        let root = dir.join("instruments/test/v1");
        std::fs::create_dir_all(root.join("Samples")).unwrap();
        std::fs::write(root.join("LICENSE"), "テスト").unwrap();
        std::fs::write(root.join("piano.sfz"), "<region>").unwrap();
        std::fs::write(root.join("kit.sfz"), "<region>").unwrap();
        let c = fixture_catalog();
        assert_eq!(resolve(&c, "piano", Some(&dir)).unwrap(), None);
        std::fs::write(
            root.join(".installed.json"),
            r#"{"version":"v1","sha256":"wrong"}"#,
        )
        .unwrap();
        assert_eq!(resolve(&c, "piano", Some(&dir)).unwrap(), None);
        std::fs::write(
            root.join(".installed.json"),
            r#"{"version":"v1","sha256":"hash"}"#,
        )
        .unwrap();
        assert_eq!(
            resolve(&c, "piano", Some(&dir)).unwrap().unwrap(),
            InstalledInstrument {
                sfz: root.join("piano.sfz"),
                one_shot: false
            }
        );
        assert_eq!(
            resolve(&c, "drums", Some(&dir)).unwrap().unwrap(),
            InstalledInstrument {
                sfz: root.join("kit.sfz"),
                one_shot: true
            }
        );
        std::fs::remove_file(root.join("LICENSE")).unwrap();
        assert_eq!(resolve(&c, "piano", Some(&dir)).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 上位や絶対パスを台帳からも受け取らない() {
        let mut c = fixture_catalog();
        for path in ["../piano.sfz", "/piano.sfz"] {
            c.instruments.get_mut("piano").unwrap().sfz = path.into();
            assert!(resolve(&c, "piano", None).is_err());
        }
    }
}
