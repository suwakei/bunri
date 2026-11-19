//! 手元に導入した音源を監査する。通常のテストはダウンロードを必要としない。
//!
//! cargo run -p bunri-audio --example audit_sfz -- 音源一覧.json
//! 一覧は [{"id":"楽器のID","sfz":"/音源の場所.sfz"}]。

use bunri_audio::Sampler;
use serde_json::{json, Value};
use std::path::Path;

const SAMPLE_RATE: usize = 48_000;
const BLOCK: usize = 256;
const AUDIBLE: f32 = 1e-6;

/// ノートを1つ鳴らし、そのあいだの山の高さを返す。前のノートの余韻は混ぜない。
fn probe(sampler: &mut Sampler, pitch: u8, frames: usize) -> Result<f32, String> {
    sampler.all_sound_off();
    sampler.note_on(0, pitch, 127);
    let (mut left, mut right) = ([0.0; BLOCK], [0.0; BLOCK]);
    let mut peak = 0.0f32;
    let mut done = 0;
    while done < frames {
        let len = BLOCK.min(frames - done);
        sampler.render(&mut left[..len], &mut right[..len]);
        for value in left[..len].iter().chain(&right[..len]) {
            if !value.is_finite() {
                return Err(format!("高さ {pitch} の音声に数値でない値があります"));
            }
            peak = peak.max(value.abs());
        }
        done += len;
    }
    sampler.note_off(0, pitch);
    Ok(peak)
}

fn audit(entry: &Value) -> Value {
    let id = entry.get("id").and_then(Value::as_str).unwrap_or("不明");
    let mut regions = 0;
    let mut preloaded = 0;
    let mut peak = 0.0f32;
    let result = (|| -> Result<(), String> {
        let sfz = entry
            .get("sfz")
            .and_then(Value::as_str)
            .ok_or("SFZ の場所がありません")?;
        let mut sampler = Sampler::new(SAMPLE_RATE as f32, BLOCK);
        sampler
            .load_file(Path::new(sfz))
            .map_err(|e| e.to_string())?;
        sampler.set_offline(true);
        regions = sampler.num_regions();
        preloaded = sampler.preloaded_samples();
        if regions == 0 || preloaded == 0 {
            return Err("領域または読み込めたサンプルが0件です".into());
        }
        for pitch in [36, 48, 60, 72, 84] {
            peak = peak.max(probe(&mut sampler, pitch, SAMPLE_RATE * 3 / 10)?);
        }
        // 打楽器や特殊な音域の音源は、別の高さだけに割り当てられていることがある。
        if peak < AUDIBLE {
            for pitch in 0..=127 {
                peak = peak.max(probe(&mut sampler, pitch, SAMPLE_RATE / 10)?);
                if peak >= AUDIBLE {
                    break;
                }
            }
        }
        if peak < AUDIBLE {
            return Err("割り当てられた高さを調べても音が出ません".into());
        }
        Ok(())
    })();
    json!({"id":id,"regions":regions,"preloaded":preloaded,"peak":peak,"error":result.err()})
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("使い方: audit_sfz 音源一覧.json")?;
    let entries: Vec<Value> = serde_json::from_slice(&std::fs::read(manifest)?)?;
    let mut failed = false;
    for entry in entries {
        let result = audit(&entry);
        failed |= !result["error"].is_null();
        println!("{result}");
    }
    if failed {
        std::process::exit(1);
    }
    Ok(())
}
