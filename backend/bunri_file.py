"""
bunri DAW — `.bunri` ドキュメントファイル（SQLite ベース）

1ファイル = 1曲のプロジェクトドキュメント。CLIP STUDIO の ``.clip`` や
Ableton の ``.als`` と同じ思想で、ユーザーが持ち運べる単一ファイルとして
カルテと元音声を保持する。

形式の版:

- v1（``format_version`` 1.0）: カルテと元音声だけ（``results/charts/*.bunri``）
- v2（2.0）: プロジェクト全体。トラック・ノート・お手本・クリップと音声（FLAC で可逆圧縮、
  中身のハッシュで重複を除く）・グリッド・学ぶ流れの状態・学習の記録・ガイドと説明の写し。
  カルテのテーブルは v1 のまま使う。v1 のファイルは ``migrate`` で v2 に上げられる（開くときは
  作業用の写しを上げるので、利用者のファイルそのものは書き換えない）

v2 の表の一覧と、練習画面などが状態を足すときの決まり（``project_state``）は
docs/song-chart-design.md「プロジェクトの保存（.bunri v2）」。

前方互換の方針:
- 読み込み時、既知のテーブル・列だけを明示的に SELECT する
- 未知のテーブルや列は無視する（新しい bunri が書いたファイルを古い bunri が開ける）
- メジャーバージョンが上のファイルだけは拒否する

依存は Python 標準ライブラリの sqlite3 のみ。追加パッケージを要求しないため
デスクトップアプリへ移行してもそのまま持っていける。
"""
import sqlite3
from pathlib import Path

# ファイルフォーマットのバージョン。メジャーが上がると後方互換を壊す変更
# （2.0: プロジェクト全体を持つようにした。v1 の bunri は v2 のファイルを「新しい形式」として断る）
FORMAT_VERSION = "2.0"

# 1ファイル1曲のため、カルテの行 ID は常にこれ
CHART_ID = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bunri_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS charts (
    id                  INTEGER PRIMARY KEY,
    schema_version      INTEGER NOT NULL,
    filename            TEXT,
    duration_sec        REAL,
    bpm                 REAL,
    bpm_confidence      REAL,
    bpm_source          TEXT,
    downbeat_offset_sec REAL,
    beats_per_bar       INTEGER,
    beat_unit           INTEGER,
    user_confirmed      INTEGER,
    key_tonic           TEXT,
    key_mode            TEXT,
    key_confidence      REAL
);

CREATE TABLE IF NOT EXISTS chart_key_alternatives (
    chart_id   INTEGER NOT NULL,
    position   INTEGER NOT NULL,
    tonic      TEXT,
    mode       TEXT,
    confidence REAL,
    PRIMARY KEY (chart_id, position)
);

CREATE TABLE IF NOT EXISTS chart_beats (
    chart_id   INTEGER NOT NULL,
    beat_index INTEGER NOT NULL,
    time_sec   REAL NOT NULL,
    PRIMARY KEY (chart_id, beat_index)
);

CREATE TABLE IF NOT EXISTS chart_sections (
    chart_id             INTEGER NOT NULL,
    section_id           TEXT NOT NULL,
    position             INTEGER NOT NULL,
    label                TEXT,
    suggested_label      TEXT,
    suggested_confidence REAL,
    start_bar            INTEGER,
    end_bar              INTEGER,
    start_sec            REAL,
    end_sec              REAL,
    repeat_group         TEXT,
    rms_db               REAL,
    onset_density        REAL,
    PRIMARY KEY (chart_id, section_id)
);

CREATE TABLE IF NOT EXISTS chart_chords (
    chart_id   INTEGER NOT NULL,
    beat_index INTEGER NOT NULL,
    beat_count INTEGER,
    bar        INTEGER,
    beat       INTEGER,
    start_sec  REAL,
    end_sec    REAL,
    root       TEXT,
    quality    TEXT,
    symbol     TEXT,
    degree     TEXT,
    confidence REAL,
    PRIMARY KEY (chart_id, beat_index)
);

CREATE TABLE IF NOT EXISTS chart_mix (
    chart_id          INTEGER PRIMARY KEY,
    loudness_lufs     REAL,
    peak_dbfs         REAL,
    dynamic_range_db  REAL,
    stereo_width      REAL,
    bass_mono         INTEGER,
    reverb_tail_sec   REAL
);

CREATE TABLE IF NOT EXISTS chart_mix_bands (
    chart_id  INTEGER NOT NULL,
    position  INTEGER NOT NULL,
    name      TEXT,
    hz_low    INTEGER,
    hz_high   INTEGER,
    energy_db REAL,
    PRIMARY KEY (chart_id, position)
);

CREATE TABLE IF NOT EXISTS chart_unavailable (
    chart_id INTEGER NOT NULL,
    field    TEXT NOT NULL,
    reason   TEXT,
    PRIMARY KEY (chart_id, field)
);

CREATE TABLE IF NOT EXISTS chart_audio (
    chart_id      INTEGER PRIMARY KEY,
    filename      TEXT,
    embedded      INTEGER NOT NULL,
    external_path TEXT,
    data          BLOB,
    audio_hash    TEXT
);
""" + """
-- ---- v2: プロジェクト ----
CREATE TABLE IF NOT EXISTS project (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    bpm             REAL,
    beats_per_bar   INTEGER,
    grid_offset_sec REAL,
    created_at      TEXT,
    modified_at     TEXT,
    uuid            TEXT
);

CREATE TABLE IF NOT EXISTS project_tracks (
    position      INTEGER PRIMARY KEY,
    name          TEXT,
    role          TEXT,
    part          TEXT,
    practice_of   INTEGER,
    gain_db       REAL,
    pan           REAL,
    mute          INTEGER,
    solo          INTEGER,
    has_reference INTEGER NOT NULL DEFAULT 0,
    extra         TEXT
);

CREATE TABLE IF NOT EXISTS project_notes (
    track_position INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    position       INTEGER NOT NULL,
    note           TEXT,
    octave         INTEGER,
    step           INTEGER,
    length         INTEGER,
    velocity       INTEGER,
    PRIMARY KEY (track_position, kind, position)
);

CREATE TABLE IF NOT EXISTS project_clips (
    track_position INTEGER NOT NULL,
    position       INTEGER NOT NULL,
    name           TEXT,
    offset_sec     REAL,
    duration_sec   REAL,
    audio_hash     TEXT,
    PRIMARY KEY (track_position, position)
);

CREATE TABLE IF NOT EXISTS audio_blobs (
    hash         TEXT PRIMARY KEY,
    codec        TEXT NOT NULL,
    filename     TEXT,
    sample_rate  INTEGER,
    channels     INTEGER,
    frames       INTEGER,
    subtype      TEXT,
    source_bytes INTEGER,
    data         BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS project_state (
    section TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at     TEXT NOT NULL,
    reference_track INTEGER,
    attempt_track   INTEGER,
    part            TEXT,
    start_bar       INTEGER,
    end_bar         INTEGER,
    reference_count INTEGER,
    matched         INTEGER,
    match_rate      REAL,
    missing         INTEGER,
    pitch           INTEGER,
    octave          INTEGER,
    extra           INTEGER,
    timing          INTEGER,
    length          INTEGER,
    explanation_id  TEXT
);

CREATE TABLE IF NOT EXISTS cached_results (
    kind TEXT NOT NULL,
    key  TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (kind, key)
);
"""

# カルテを構成するテーブル。再計算時にまとめて削除する対象
_CHART_TABLES = [
    "chart_key_alternatives", "chart_beats", "chart_sections",
    "chart_chords", "chart_mix", "chart_mix_bands", "chart_unavailable",
]


class BunriFileError(Exception):
    """`.bunri` ファイルの読み書きで発生したエラーを表す例外クラス。

    フォーマットバージョンの不整合、必要なテーブルの欠落、カルテ未保存の
    ファイルを読もうとした場合などに送出される。
    """
    pass


def _connect(path):
    """`.bunri` ファイルへの SQLite 接続を開く。

    Args:
        path (str | pathlib.Path): `.bunri` ファイルのパス。

    Returns:
        sqlite3.Connection: 行を名前で引ける接続オブジェクト。
    """
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def create(path, chart, audio_path=None, embed_audio=True, app_version="0.1.0", audio_data=None):
    """カルテ（と任意で元音声）を保持する `.bunri` ファイルを新規作成する。

    既存ファイルがある場合は上書きする。1ファイル1曲のため、複数のカルテを
    1つのファイルに入れることはできない。

    Args:
        path (str | pathlib.Path): 作成する `.bunri` ファイルのパス。
        chart (dict): ``song_chart.build_chart`` が返したカルテ辞書。
        audio_path (str | pathlib.Path | None, optional): 元音声ファイルのパス。
            None なら音声を保存しない。
        embed_audio (bool, optional): True なら音声のバイト列をファイル内に
            内包する。False なら外部パスの参照のみを保存する。デフォルト True。
            既定を内包にしているのは、リンク切れが初心者には対処不能な失敗
            になるため。
        app_version (str, optional): 書き込んだアプリのバージョン。診断用。
        audio_data (tuple[str, bytes] | None, optional): ``(ファイル名, バイト列)``。ファイルではなく
            手元のバイト列を内包するとき（プロジェクトを開いたときに、カルテを作り直さずに置き直す経路）。
            ``audio_path`` より優先する。

    Returns:
        pathlib.Path: 作成された `.bunri` ファイルのパス。

    Raises:
        FileNotFoundError: ``embed_audio`` が True で ``audio_path`` が
            存在しない場合。

    Side Effects:
        指定パスにファイルを作成する。親ディレクトリが無い場合は作成する。
    """
    import time

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()

    conn = _connect(target)
    try:
        conn.executescript(_SCHEMA)
        conn.executemany(
            "INSERT OR REPLACE INTO bunri_meta (key, value) VALUES (?, ?)",
            [
                ("format_version", FORMAT_VERSION),
                ("app_version", str(app_version)),
                ("created_by", "bunri"),
                ("created_at", str(int(time.time()))),
            ],
        )
        _write_chart(conn, chart)
        if audio_data is not None:
            name, data = audio_data
            conn.execute(
                """INSERT OR REPLACE INTO chart_audio
                       (chart_id, filename, embedded, external_path, data, audio_hash)
                   VALUES (?,?,?,?,?,NULL)""",
                (CHART_ID, name, 1, None, bytes(data)),
            )
        elif audio_path is not None:
            _write_audio(conn, audio_path, embed_audio)
        conn.commit()
    finally:
        conn.close()

    return target


def update_chart(path, chart):
    """既存の `.bunri` ファイルのカルテを差し替える。

    グリッド補正後の再計算結果を書き戻す経路。音声データには触れない。

    Args:
        path (str | pathlib.Path): 更新する `.bunri` ファイルのパス。
        chart (dict): 新しいカルテ辞書。

    Raises:
        BunriFileError: ファイルが存在しない、またはフォーマットバージョンが
            読み込み不能な場合。

    Side Effects:
        カルテ関連テーブルの内容を全て置き換える。
    """
    target = Path(path)
    if not target.exists():
        raise BunriFileError(f".bunri ファイルが見つかりません: {path}")

    conn = _connect(target)
    try:
        _check_version(conn)
        _ensure_schema(conn)
        _write_chart(conn, chart)
        conn.commit()
    finally:
        conn.close()


def _write_chart(conn, chart):
    """カルテ辞書をカルテ関連テーブルへ書き込む。

    既存のカルテ行は全て削除してから書き直すため、部分更新にはならない。

    Args:
        conn (sqlite3.Connection): 書き込み先の接続。
        chart (dict): カルテ辞書。

    Side Effects:
        カルテ関連テーブルの該当 chart_id の行を削除し、新しい内容を挿入する。
        コミットは呼び出し側が行う。
    """
    grid = chart.get("grid") or {}
    key = chart.get("key") or {}
    mix = chart.get("mix") or {}
    source = chart.get("source") or {}
    time_signature = grid.get("time_signature") or [4, 4]

    conn.execute("DELETE FROM charts WHERE id = ?", (CHART_ID,))
    for table in _CHART_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE chart_id = ?", (CHART_ID,))

    conn.execute(
        """INSERT INTO charts (
               id, schema_version, filename, duration_sec,
               bpm, bpm_confidence, bpm_source, downbeat_offset_sec,
               beats_per_bar, beat_unit, user_confirmed,
               key_tonic, key_mode, key_confidence
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            CHART_ID, int(chart.get("version", 1)),
            source.get("filename"), source.get("duration_sec"),
            grid.get("bpm"), grid.get("bpm_confidence"), grid.get("bpm_source"),
            grid.get("downbeat_offset_sec"),
            int(time_signature[0]), int(time_signature[1]),
            1 if grid.get("user_confirmed") else 0,
            key.get("tonic"), key.get("mode"), key.get("confidence"),
        ),
    )

    conn.executemany(
        "INSERT INTO chart_key_alternatives (chart_id, position, tonic, mode, confidence) VALUES (?,?,?,?,?)",
        [
            (CHART_ID, i, alt.get("tonic"), alt.get("mode"), alt.get("confidence"))
            for i, alt in enumerate(key.get("alternatives") or [])
        ],
    )

    conn.executemany(
        "INSERT INTO chart_beats (chart_id, beat_index, time_sec) VALUES (?,?,?)",
        [(CHART_ID, i, float(t)) for i, t in enumerate(grid.get("beat_times_sec") or [])],
    )

    conn.executemany(
        """INSERT INTO chart_sections (
               chart_id, section_id, position, label, suggested_label, suggested_confidence,
               start_bar, end_bar, start_sec, end_sec, repeat_group, rms_db, onset_density
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                CHART_ID, s.get("id"), i, s.get("label"),
                s.get("suggested_label"), s.get("suggested_confidence"),
                s.get("start_bar"), s.get("end_bar"), s.get("start_sec"), s.get("end_sec"),
                s.get("repeat_group"),
                (s.get("features") or {}).get("rms_db"),
                (s.get("features") or {}).get("onset_density"),
            )
            for i, s in enumerate(chart.get("sections") or [])
        ],
    )

    conn.executemany(
        """INSERT INTO chart_chords (
               chart_id, beat_index, beat_count, bar, beat, start_sec, end_sec,
               root, quality, symbol, degree, confidence
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                CHART_ID, c.get("beat_index"), c.get("beat_count"),
                c.get("bar"), c.get("beat"), c.get("start_sec"), c.get("end_sec"),
                c.get("root"), c.get("quality"), c.get("symbol"),
                c.get("degree"), c.get("confidence"),
            )
            for c in chart.get("chords") or []
        ],
    )

    conn.execute(
        """INSERT INTO chart_mix (
               chart_id, loudness_lufs, peak_dbfs, dynamic_range_db,
               stereo_width, bass_mono, reverb_tail_sec
           ) VALUES (?,?,?,?,?,?,?)""",
        (
            CHART_ID, mix.get("loudness_lufs"), mix.get("peak_dbfs"),
            mix.get("dynamic_range_db"), mix.get("stereo_width"),
            None if mix.get("bass_mono") is None else int(bool(mix.get("bass_mono"))),
            mix.get("reverb_tail_sec"),
        ),
    )

    conn.executemany(
        "INSERT INTO chart_mix_bands (chart_id, position, name, hz_low, hz_high, energy_db) VALUES (?,?,?,?,?,?)",
        [
            (CHART_ID, i, b.get("name"), (b.get("hz") or [0, 0])[0], (b.get("hz") or [0, 0])[1], b.get("energy_db"))
            for i, b in enumerate(mix.get("spectrum_bands") or [])
        ],
    )

    conn.executemany(
        "INSERT INTO chart_unavailable (chart_id, field, reason) VALUES (?,?,?)",
        [(CHART_ID, field, reason) for field, reason in (chart.get("unavailable") or {}).items()],
    )


def _write_audio(conn, audio_path, embed):
    """元音声をファイルに内包、または外部参照として記録する。

    Args:
        conn (sqlite3.Connection): 書き込み先の接続。
        audio_path (str | pathlib.Path): 元音声ファイルのパス。
        embed (bool): True なら音声のバイト列を BLOB として内包する。

    Raises:
        FileNotFoundError: ``embed`` が True でファイルが存在しない場合。

    Side Effects:
        ``chart_audio`` テーブルに1行書き込む。コミットは呼び出し側が行う。
    """
    source = Path(audio_path)
    if embed and not source.exists():
        raise FileNotFoundError(f"内包する音声ファイルが見つかりません: {audio_path}")

    data = source.read_bytes() if embed else None
    conn.execute(
        """INSERT OR REPLACE INTO chart_audio
               (chart_id, filename, embedded, external_path, data)
           VALUES (?,?,?,?,?)""",
        (CHART_ID, source.name, 1 if embed else 0, None if embed else str(source.resolve()), data),
    )


def _check_version(conn):
    """ファイルのフォーマットバージョンが読み込み可能か検証する。

    メジャーバージョンが自分より新しいファイルのみ拒否する。マイナー差は
    前方互換とみなして読み込む（未知のテーブル・列は SELECT しないため
    自然に無視される）。

    Args:
        conn (sqlite3.Connection): 検証する接続。

    Returns:
        str: ファイルの ``format_version``。

    Raises:
        BunriFileError: ``bunri_meta`` が存在しない場合。
        BunriFileError: メジャーバージョンが自分より新しい場合。
    """
    try:
        row = conn.execute("SELECT value FROM bunri_meta WHERE key = 'format_version'").fetchone()
    except sqlite3.DatabaseError as e:
        raise BunriFileError("bunri形式のファイルではありません（bunri_meta が見つかりません）") from e

    version = row["value"] if row else "0.0"
    try:
        file_major = int(str(version).split(".")[0])
    except (ValueError, IndexError):
        raise BunriFileError(f"フォーマットバージョンを解釈できません: {version}")

    our_major = int(FORMAT_VERSION.split(".")[0])
    if file_major > our_major:
        raise BunriFileError(
            f"このファイルは新しい形式（v{version}）です。bunri を更新してください。"
        )
    return str(version)


def read_meta(path):
    """`.bunri` ファイルのメタ情報を辞書で返す。

    Args:
        path (str | pathlib.Path): `.bunri` ファイルのパス。

    Returns:
        dict[str, str]: ``format_version`` / ``app_version`` / ``created_by`` /
            ``created_at`` などのキーを持つ辞書。

    Raises:
        BunriFileError: ファイルが存在しない、または bunri 形式でない場合。
    """
    target = Path(path)
    if not target.exists():
        raise BunriFileError(f".bunri ファイルが見つかりません: {path}")

    conn = _connect(target)
    try:
        _check_version(conn)
        rows = conn.execute("SELECT key, value FROM bunri_meta").fetchall()
        return {row["key"]: row["value"] for row in rows}
    finally:
        conn.close()


def read_chart(path):
    """`.bunri` ファイルからカルテを読み出して辞書で返す。

    ``song_chart.build_chart`` が返すのと同じ構造に復元する。読み出し後に
    ``song_chart.normalize_chart`` を通しているため、書き込み前と同じ
    正規化済みの形になる。

    Args:
        path (str | pathlib.Path): `.bunri` ファイルのパス。

    Returns:
        dict: カルテ辞書。

    Raises:
        BunriFileError: ファイルが存在しない、bunri 形式でない、または
            カルテが保存されていない場合。
    """
    import song_chart

    target = Path(path)
    if not target.exists():
        raise BunriFileError(f".bunri ファイルが見つかりません: {path}")

    conn = _connect(target)
    try:
        _check_version(conn)
        head = conn.execute("SELECT * FROM charts WHERE id = ?", (CHART_ID,)).fetchone()
        if head is None:
            raise BunriFileError("このファイルにはカルテが保存されていません")

        chart = {
            "version": head["schema_version"],
            "source": {
                "filename": head["filename"],
                "duration_sec": head["duration_sec"],
            },
            "grid": {
                "bpm": head["bpm"],
                "bpm_confidence": head["bpm_confidence"],
                "bpm_source": head["bpm_source"],
                "downbeat_offset_sec": head["downbeat_offset_sec"],
                "time_signature": [head["beats_per_bar"], head["beat_unit"]],
                "beat_times_sec": _read_beats(conn),
                "user_confirmed": bool(head["user_confirmed"]),
            },
            "key": {
                "tonic": head["key_tonic"],
                "mode": head["key_mode"],
                "confidence": head["key_confidence"],
                "alternatives": _read_key_alternatives(conn),
            },
            "sections": _read_sections(conn),
            "chords": _read_chords(conn),
            "mix": _read_mix(conn),
            "unavailable": _read_unavailable(conn),
        }
        return song_chart.normalize_chart(chart)
    finally:
        conn.close()


def _read_beats(conn):
    """実測ビート列を昇順で読み出す。

    Args:
        conn (sqlite3.Connection): 読み出し元の接続。

    Returns:
        list[float]: ビート位置（秒）のリスト。
    """
    rows = conn.execute(
        "SELECT time_sec FROM chart_beats WHERE chart_id = ? ORDER BY beat_index", (CHART_ID,)
    ).fetchall()
    return [float(row["time_sec"]) for row in rows]


def _read_key_alternatives(conn):
    """キーの次点候補を読み出す。

    Args:
        conn (sqlite3.Connection): 読み出し元の接続。

    Returns:
        list[dict]: ``{"tonic": str, "mode": str, "confidence": float}`` のリスト。
    """
    rows = conn.execute(
        "SELECT tonic, mode, confidence FROM chart_key_alternatives WHERE chart_id = ? ORDER BY position",
        (CHART_ID,),
    ).fetchall()
    return [
        {"tonic": row["tonic"], "mode": row["mode"], "confidence": row["confidence"]}
        for row in rows
    ]


def _read_sections(conn):
    """セクションを並び順で読み出す。

    Args:
        conn (sqlite3.Connection): 読み出し元の接続。

    Returns:
        list[dict]: ``structure.detect_sections`` と同じ形式のリスト。
    """
    rows = conn.execute(
        """SELECT section_id, label, suggested_label, suggested_confidence,
                  start_bar, end_bar, start_sec, end_sec, repeat_group, rms_db, onset_density
           FROM chart_sections WHERE chart_id = ? ORDER BY position""",
        (CHART_ID,),
    ).fetchall()
    return [
        {
            "id": row["section_id"],
            "label": row["label"],
            "suggested_label": row["suggested_label"],
            "suggested_confidence": row["suggested_confidence"],
            "start_bar": row["start_bar"],
            "end_bar": row["end_bar"],
            "start_sec": row["start_sec"],
            "end_sec": row["end_sec"],
            "repeat_group": row["repeat_group"],
            "features": {"rms_db": row["rms_db"], "onset_density": row["onset_density"]},
        }
        for row in rows
    ]


def _read_chords(conn):
    """コード進行をビート順で読み出す。

    Args:
        conn (sqlite3.Connection): 読み出し元の接続。

    Returns:
        list[dict]: ``music_theory.detect_chords`` と同じ形式に
            ``bar`` / ``beat`` を加えたリスト。
    """
    rows = conn.execute(
        """SELECT beat_index, beat_count, bar, beat, start_sec, end_sec,
                  root, quality, symbol, degree, confidence
           FROM chart_chords WHERE chart_id = ? ORDER BY beat_index""",
        (CHART_ID,),
    ).fetchall()
    return [dict(row) for row in rows]


def _read_mix(conn):
    """ミックス特性を読み出す。

    Args:
        conn (sqlite3.Connection): 読み出し元の接続。

    Returns:
        dict: ``mix_profile.analyze_mix`` と同じ形式の辞書。
            行が存在しない場合は全項目 None の辞書。
    """
    row = conn.execute("SELECT * FROM chart_mix WHERE chart_id = ?", (CHART_ID,)).fetchone()
    bands = conn.execute(
        "SELECT name, hz_low, hz_high, energy_db FROM chart_mix_bands WHERE chart_id = ? ORDER BY position",
        (CHART_ID,),
    ).fetchall()

    spectrum = [
        {"name": b["name"], "hz": [b["hz_low"], b["hz_high"]], "energy_db": b["energy_db"]}
        for b in bands
    ]
    if row is None:
        return {
            "loudness_lufs": None, "peak_dbfs": None, "dynamic_range_db": None,
            "stereo_width": None, "bass_mono": None, "reverb_tail_sec": None,
            "spectrum_bands": spectrum,
        }

    return {
        "loudness_lufs": row["loudness_lufs"],
        "peak_dbfs": row["peak_dbfs"],
        "dynamic_range_db": row["dynamic_range_db"],
        "stereo_width": row["stereo_width"],
        "bass_mono": None if row["bass_mono"] is None else bool(row["bass_mono"]),
        "reverb_tail_sec": row["reverb_tail_sec"],
        "spectrum_bands": spectrum,
    }


def _read_unavailable(conn):
    """検出できなかった項目とその理由を読み出す。

    Args:
        conn (sqlite3.Connection): 読み出し元の接続。

    Returns:
        dict[str, str]: フィールド名 -> 理由の辞書。
    """
    rows = conn.execute(
        "SELECT field, reason FROM chart_unavailable WHERE chart_id = ?", (CHART_ID,)
    ).fetchall()
    return {row["field"]: row["reason"] for row in rows}


def extract_audio(path, dest_dir):
    """`.bunri` に内包された元音声を取り出してファイルに書き出す。

    グリッド補正後の再解析には元音声が必要になるため、その取り出し口。
    外部参照で保存されている場合は、書き出さずに参照先のパスを返す。

    Args:
        path (str | pathlib.Path): `.bunri` ファイルのパス。
        dest_dir (str | pathlib.Path): 書き出し先ディレクトリ。
            存在しない場合は作成する。

    Returns:
        pathlib.Path | None: 取り出した音声ファイルのパス。
            音声が保存されていない場合、または外部参照先が存在しない場合は None。

    Raises:
        BunriFileError: ファイルが存在しない、または bunri 形式でない場合。

    Side Effects:
        内包音声がある場合、``dest_dir`` にファイルを書き出す。
    """
    target = Path(path)
    if not target.exists():
        raise BunriFileError(f".bunri ファイルが見つかりません: {path}")

    conn = _connect(target)
    try:
        _check_version(conn)
        row = conn.execute(
            "SELECT * FROM chart_audio WHERE chart_id = ?",
            (CHART_ID,),
        ).fetchone()
        if row is None:
            return None

        # v2 のプロジェクトでは、元音声は audio_blobs に 1 つだけ持ち、ここはハッシュで指す
        audio_hash = row["audio_hash"] if "audio_hash" in row.keys() else None
        if audio_hash:
            blob = _read_blob(conn, audio_hash)
            if blob is None:
                return None
            out_dir = Path(dest_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            data, _media, ext = blob
            name = Path(row["filename"] or "audio").stem + ext
            out_path = out_dir / name
            out_path.write_bytes(data)
            return out_path

        if not row["embedded"]:
            external = Path(row["external_path"]) if row["external_path"] else None
            return external if external and external.exists() else None

        out_dir = Path(dest_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / (row["filename"] or "audio.wav")
        out_path.write_bytes(row["data"] or b"")
        return out_path
    finally:
        conn.close()


def chart_json(path):
    """`.bunri` からカルテを読み出し、バイト安定な JSON 文字列で返す。

    LLM へ渡すプロンプトのプレフィックスとしてそのまま使える形。

    Args:
        path (str | pathlib.Path): `.bunri` ファイルのパス。

    Returns:
        str: 正規化・キー順固定済みの JSON 文字列。

    Raises:
        BunriFileError: 読み出しに失敗した場合。
    """
    import song_chart
    return song_chart.to_canonical_json(read_chart(path))


# ======================================================================
# v2: プロジェクト全体
# ======================================================================

# 音声のハッシュ（元のバイト列の SHA-256）の形
_HASH_CHARS = set("0123456789abcdef")

# FLAC に直して持つ（= 可逆で小さくなる）元の形式と、サンプルの型。
# FLAC が持てるのは 24 bit までの整数なので、浮動小数（FLOAT / DOUBLE）や圧縮済みの形式（MP3 など）は元のまま持つ
_FLAC_SUBTYPES = {"PCM_16": "int16", "PCM_24": "int32", "PCM_S8": "int16"}
_FLAC_SOURCE_FORMATS = {"WAV", "WAVEX", "AIFF", "W64", "RF64"}

# 学習の記録の、差分の種類ごとの件数の列（coach_diff.KINDS と同じ並び）
_HISTORY_KINDS = ("missing", "pitch", "octave", "extra", "timing", "length")

# プロジェクトの文書（API でやり取りする JSON）の版
DOCUMENT_VERSION = 1


def is_audio_hash(value):
    """音声のハッシュ（64 桁の小文字 16 進）か。

    Args:
        value: 調べる値。

    Returns:
        bool: ハッシュの形なら True。
    """
    return isinstance(value, str) and len(value) == 64 and set(value) <= _HASH_CHARS


def audio_hash(data):
    """音声のバイト列のハッシュ（重複を除く鍵）を返す。

    Args:
        data (bytes): 元のファイルのバイト列。

    Returns:
        str: SHA-256 の 64 桁の 16 進文字列。
    """
    import hashlib
    return hashlib.sha256(data).hexdigest()


def encode_audio(data, filename=None):
    """音声のバイト列を、`.bunri` に入れる形にする。

    整数 PCM の WAV / AIFF（16・24・8 bit）は FLAC に直す（可逆。サンプルは 1 つも変わらない）。
    それ以外（MP3・M4A・浮動小数の WAV・FLAC そのもの・読めない形式）は元のバイト列のまま持つ。

    Args:
        data (bytes): 元のファイルのバイト列。
        filename (str | None): 元のファイル名（取り出すときの拡張子に使う）。

    Returns:
        dict: ``audio_blobs`` の 1 行（``hash`` ``codec`` ``filename`` ``sample_rate`` ``channels``
        ``frames`` ``subtype`` ``source_bytes`` ``data``）。
    """
    import io

    import soundfile as sf

    row = {
        "hash": audio_hash(data), "codec": "raw", "filename": filename,
        "sample_rate": None, "channels": None, "frames": None, "subtype": None,
        "source_bytes": len(data), "data": bytes(data),
    }
    try:
        info = sf.info(io.BytesIO(data))
    except Exception:
        return row
    row.update(sample_rate=int(info.samplerate), channels=int(info.channels), frames=int(info.frames),
               subtype=info.subtype)
    dtype = _FLAC_SUBTYPES.get(info.subtype)
    if dtype is None or info.format not in _FLAC_SOURCE_FORMATS:
        return row
    samples, sr = sf.read(io.BytesIO(data), dtype=dtype, always_2d=True)
    out = io.BytesIO()
    flac_subtype = "PCM_S8" if info.subtype == "PCM_S8" else info.subtype
    sf.write(out, samples, sr, format="FLAC", subtype=flac_subtype)
    encoded = out.getvalue()
    # まれに FLAC のほうが大きくなる (雑音だけの音など)。そのときは元のまま持つ
    if len(encoded) < len(data):
        row.update(codec="flac", data=encoded)
    return row


def decode_audio(codec, data, filename=None, subtype=None):
    """`.bunri` に入れた音声を、画面が読める形（バイト列・メディアタイプ・拡張子）に戻す。

    FLAC で持っているものは、元と同じサンプルの型の WAV に戻す（WebView は FLAC を読めないことがあるため）。
    サンプルは元のファイルとビット単位で一致する（ヘッダの付帯情報は落ちる）。

    Args:
        codec (str): ``"flac"`` か ``"raw"``。
        data (bytes): 持っているバイト列。
        filename (str | None): 元のファイル名。
        subtype (str | None): 元のサンプルの型（``PCM_16`` など）。

    Returns:
        tuple[bytes, str, str]: ``(バイト列, メディアタイプ, 拡張子)``。
    """
    import io
    import mimetypes

    if codec == "flac":
        import soundfile as sf

        dtype = _FLAC_SUBTYPES.get(subtype or "PCM_16", "int32")
        samples, sr = sf.read(io.BytesIO(data), dtype=dtype, always_2d=True)
        out = io.BytesIO()
        sf.write(out, samples, sr, format="WAV", subtype=subtype if subtype in _FLAC_SUBTYPES else "PCM_24")
        return out.getvalue(), "audio/wav", ".wav"
    ext = Path(filename or "").suffix.lower() or ".bin"
    media = mimetypes.guess_type(f"a{ext}")[0] or "application/octet-stream"
    return bytes(data), media, ext


def _read_blob(conn, hash_):
    """``audio_blobs`` から 1 つ読み、画面が読める形に戻す（無ければ None）。"""
    row = conn.execute(
        "SELECT codec, filename, subtype, data FROM audio_blobs WHERE hash = ?", (hash_,)
    ).fetchone()
    if row is None:
        return None
    return decode_audio(row["codec"], row["data"], row["filename"], row["subtype"])


def _velocity(value):
    """ノートの強さを、保存する値にする。1〜127 の整数ならその値、それ以外（無い・形が違う）は None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(round(value))
    return number if 1 <= number <= 127 else None


def _table_columns(conn, table):
    """表の列名の集合を返す（表が無ければ空）。"""
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_schema(conn):
    """いまの版の表と列をそろえる（足りないものだけ作る。前の版のファイルを上げるときにも使う）。"""
    conn.executescript(_SCHEMA)
    if "audio_hash" not in _table_columns(conn, "chart_audio"):
        conn.execute("ALTER TABLE chart_audio ADD COLUMN audio_hash TEXT")
    # ノートの強さ (velocity) は後から足した列。持たないノートは NULL のまま (読む側が既定の強さとして扱う)
    if "velocity" not in _table_columns(conn, "project_notes"):
        conn.execute("ALTER TABLE project_notes ADD COLUMN velocity INTEGER")


def migrate(path):
    """`.bunri` を、いまの版（v2）に上げる。上げる必要が無ければ何もしない。

    - 表と列を足す（v1 のカルテ・元音声はそのまま）
    - カルテの元音声（``chart_audio.data``）を ``audio_blobs`` に移し、ハッシュで指す
      （プロジェクトの音声と同じ置き場にして、同じ音声を 2 つ持たないため）
    - ``format_version`` を上げる

    利用者のファイルを直接上げないこと。開くときは、作業用の写しに対して呼ぶ（``project_store``）。

    Args:
        path (str | pathlib.Path): 上げるファイル。

    Returns:
        str: 上げる前の ``format_version``。

    Raises:
        BunriFileError: ファイルが無い、bunri 形式でない、または新しすぎる場合。
    """
    target = Path(path)
    if not target.exists():
        raise BunriFileError(f".bunri ファイルが見つかりません: {path}")
    conn = _connect(target)
    try:
        before = _check_version(conn)
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT chart_id, filename, data FROM chart_audio WHERE data IS NOT NULL AND audio_hash IS NULL"
        ).fetchall()
        for row in rows:
            blob = encode_audio(bytes(row["data"]), row["filename"])
            _insert_blob(conn, blob)
            conn.execute("UPDATE chart_audio SET data = NULL, audio_hash = ? WHERE chart_id = ?",
                         (blob["hash"], row["chart_id"]))
        conn.execute("INSERT OR REPLACE INTO bunri_meta (key, value) VALUES ('format_version', ?)", (FORMAT_VERSION,))
        conn.commit()
        if rows:
            conn.execute("VACUUM")
        return before
    finally:
        conn.close()


def _insert_blob(conn, blob):
    """``audio_blobs`` に 1 行入れる（同じハッシュが在れば何もしない = 重複を持たない）。"""
    conn.execute(
        """INSERT OR IGNORE INTO audio_blobs
               (hash, codec, filename, sample_rate, channels, frames, subtype, source_bytes, data)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (blob["hash"], blob["codec"], blob.get("filename"), blob.get("sample_rate"), blob.get("channels"),
         blob.get("frames"), blob.get("subtype"), blob.get("source_bytes"), blob["data"]),
    )


def _num(value, default=0.0):
    """数に直す（数でなければ ``default``）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def _int(value, default=0):
    """整数に直す（数でなければ ``default``）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return int(value)


def _text(value, default=None):
    """文字列ならそのまま、それ以外は ``default``。"""
    return value if isinstance(value, str) else default


def document_audio_hashes(doc):
    """プロジェクトの文書が指している音声のハッシュを、重複なしで返す。

    Args:
        doc (dict): プロジェクトの文書。

    Returns:
        list[str]: ハッシュ（出てきた順）。

    Raises:
        BunriFileError: ハッシュの形でない値が混じっている場合。
    """
    seen = []
    def add(value):
        if value is None:
            return
        if not is_audio_hash(value):
            raise BunriFileError("音声の指定が正しくありません")
        if value not in seen:
            seen.append(value)
    for track in doc.get("tracks") or []:
        for clip in (track or {}).get("clips") or []:
            add((clip or {}).get("audio"))
    chart = doc.get("chart") or None
    if isinstance(chart, dict):
        add(chart.get("audio"))
    return seen


def write_project(path, doc, blobs, app_version="0.1.0", cached=()):
    """プロジェクトの文書を、`.bunri`（v2）として新しく書く。

    Args:
        path (str | pathlib.Path): 書き出す先（在れば置き換える。呼び出し側が別名に書いて置き換えること）。
        doc (dict): プロジェクトの文書（docs/song-chart-design.md「プロジェクトの保存」の形）。
        blobs (Callable[[sqlite3.Connection, list[str]], None]): 音声を入れる関数。文書が指す
            ハッシュの一覧を受け取り、``audio_blobs`` に入れる（前の版のファイルから写す、
            受け取った音声を FLAC にする、など。``project_store`` が渡す）。
        app_version (str): 書き込んだアプリの版。
        cached (Iterable[tuple[str, str, dict]]): ガイドと説明の写し（``(種類, 鍵, 中身)``）。

    Returns:
        pathlib.Path: 書いたファイル。

    Raises:
        BunriFileError: 文書の形が正しくない、または指している音声が揃わなかった場合。
    """
    import json
    import time
    import uuid

    if not isinstance(doc, dict) or not isinstance(doc.get("tracks", []), list):
        raise BunriFileError("プロジェクトの形が正しくありません")
    hashes = document_audio_hashes(doc)
    meta = doc.get("meta") or {}
    grid = doc.get("grid") or {}
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    conn = _connect(target)
    try:
        conn.executescript(_SCHEMA)
        conn.executemany(
            "INSERT OR REPLACE INTO bunri_meta (key, value) VALUES (?, ?)",
            [
                ("format_version", FORMAT_VERSION),
                ("app_version", str(app_version)),
                ("created_by", "bunri"),
                ("created_at", str(int(time.time()))),
                ("document", "project"),
            ],
        )
        conn.execute(
            """INSERT INTO project (id, name, bpm, beats_per_bar, grid_offset_sec, created_at, modified_at, uuid)
               VALUES (1,?,?,?,?,?,?,?)""",
            (
                _text(meta.get("name"), "") or "",
                _num(grid.get("bpm"), 120.0), _int(grid.get("beatsPerBar"), 4), _num(grid.get("gridOffset"), 0.0),
                _text(meta.get("createdAt")) or now, now,
                _text(meta.get("uuid")) or uuid.uuid4().hex,
            ),
        )

        blobs(conn, hashes)
        have = {row[0] for row in conn.execute("SELECT hash FROM audio_blobs").fetchall()}
        missing = [h for h in hashes if h not in have]
        if missing:
            raise BunriFileError(f"音声が {len(missing)} 個揃いませんでした。もう一度保存してください")

        _write_tracks(conn, doc.get("tracks") or [])
        chart = doc.get("chart")
        if isinstance(chart, dict) and isinstance(chart.get("chart"), dict):
            _write_chart(conn, chart["chart"])
            conn.execute(
                """INSERT OR REPLACE INTO chart_audio (chart_id, filename, embedded, external_path, data, audio_hash)
                   VALUES (?,?,1,NULL,NULL,?)""",
                (CHART_ID, _text(chart.get("audioName")), chart.get("audio")),
            )
            view = {"version": 1, "chartId": _text(chart.get("chartId")), "peaks": chart.get("peaks")}
            conn.execute("INSERT INTO project_state (section, version, json) VALUES ('chart_view', 1, ?)",
                         (json.dumps(view, ensure_ascii=False),))

        for section, value in (doc.get("state") or {}).items():
            if not isinstance(section, str) or not isinstance(value, dict) or section == "chart_view":
                continue
            conn.execute("INSERT OR REPLACE INTO project_state (section, version, json) VALUES (?,?,?)",
                         (section, _int(value.get("version"), 1), json.dumps(value, ensure_ascii=False)))

        _write_history(conn, doc.get("history") or [])
        conn.executemany(
            "INSERT OR REPLACE INTO cached_results (kind, key, json) VALUES (?,?,?)",
            [(kind, key, json.dumps(entry, ensure_ascii=False, sort_keys=True)) for kind, key, entry in cached],
        )
        conn.commit()
    except Exception:
        conn.close()
        target.unlink(missing_ok=True)
        raise
    conn.close()
    return target


def _write_tracks(conn, tracks):
    """トラック・ノート・クリップを書く。"""
    import json

    for pos, track in enumerate(tracks):
        track = track if isinstance(track, dict) else {}
        practice_of = track.get("practiceOf")
        reference = track.get("referenceNotes")
        extra = track.get("extra") if isinstance(track.get("extra"), dict) else {}
        conn.execute(
            """INSERT INTO project_tracks
                   (position, name, role, part, practice_of, gain_db, pan, mute, solo, has_reference, extra)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                pos, _text(track.get("name"), ""), _text(track.get("role")), _text(track.get("part")),
                practice_of if isinstance(practice_of, int) and not isinstance(practice_of, bool) else None,
                _num(track.get("gain"), 0.0), _num(track.get("pan"), 0.0),
                1 if track.get("mute") is True else 0, 1 if track.get("solo") is True else 0,
                1 if isinstance(reference, list) else 0,
                json.dumps(extra, ensure_ascii=False) if extra else None,
            ),
        )
        for kind, notes in (("notes", track.get("notes")), ("reference", reference)):
            conn.executemany(
                """INSERT INTO project_notes (track_position, kind, position, note, octave, step, length, velocity)
                   VALUES (?,?,?,?,?,?,?,?)""",
                [
                    (pos, kind, i, _text(n.get("note"), "C"), _int(n.get("octave"), 4),
                     _int(n.get("step")), max(1, _int(n.get("length"), 1)), _velocity(n.get("velocity")))
                    for i, n in enumerate(notes or []) if isinstance(n, dict)
                ],
            )
        conn.executemany(
            """INSERT INTO project_clips (track_position, position, name, offset_sec, duration_sec, audio_hash)
               VALUES (?,?,?,?,?,?)""",
            [
                (pos, i, _text(c.get("name"), "clip"), _num(c.get("offset"), 0.0), _num(c.get("duration"), 0.0),
                 c.get("audio"))
                for i, c in enumerate(track.get("clips") or []) if isinstance(c, dict)
            ],
        )


def _write_history(conn, history):
    """学習の記録を書く（記録した順）。"""
    rows = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        counts = entry.get("counts") if isinstance(entry.get("counts"), dict) else {}
        ref, att = entry.get("referenceTrack"), entry.get("attemptTrack")
        rows.append((
            _text(entry.get("recordedAt"), ""),
            ref if isinstance(ref, int) and not isinstance(ref, bool) else None,
            att if isinstance(att, int) and not isinstance(att, bool) else None,
            _text(entry.get("part")),
            _int(entry.get("startBar"), 1), _int(entry.get("endBar"), 1),
            _int(entry.get("referenceCount")), _int(entry.get("matched")),
            _num(entry.get("matchRate"), 0.0),
            *(_int(counts.get(kind)) for kind in _HISTORY_KINDS),
            _text(entry.get("explanationId")),
        ))
    conn.executemany(
        f"""INSERT INTO learning_history
               (recorded_at, reference_track, attempt_track, part, start_bar, end_bar, reference_count, matched,
                match_rate, {", ".join(_HISTORY_KINDS)}, explanation_id)
            VALUES (?,?,?,?,?,?,?,?,?,{",".join("?" * len(_HISTORY_KINDS))},?)""",
        rows,
    )


def copy_blobs(conn, source_path, hashes):
    """別の `.bunri` から、指定したハッシュの音声だけを写す（作り直さないので速い）。

    Args:
        conn (sqlite3.Connection): 書き込み先の接続。
        source_path (str | pathlib.Path): 写し元のファイル。
        hashes (Iterable[str]): 写すハッシュ。

    Returns:
        set[str]: 写せたハッシュ。
    """
    wanted = [h for h in hashes if is_audio_hash(h)]
    if not wanted or not Path(source_path).exists():
        return set()
    conn.execute("ATTACH DATABASE ? AS src", (str(source_path),))
    try:
        if "hash" not in {row[1] for row in conn.execute("PRAGMA src.table_info(audio_blobs)").fetchall()}:
            return set()
        placeholders = ",".join("?" * len(wanted))
        conn.execute(
            f"""INSERT OR IGNORE INTO main.audio_blobs
                    (hash, codec, filename, sample_rate, channels, frames, subtype, source_bytes, data)
                SELECT hash, codec, filename, sample_rate, channels, frames, subtype, source_bytes, data
                FROM src.audio_blobs WHERE hash IN ({placeholders})""",
            wanted,
        )
        conn.commit()
        rows = conn.execute(f"SELECT hash FROM main.audio_blobs WHERE hash IN ({placeholders})", wanted).fetchall()
        return {row[0] for row in rows}
    finally:
        conn.execute("DETACH DATABASE src")


def insert_audio(conn, data, filename=None, expected_hash=None):
    """音声のバイト列を FLAC（かそのまま）にして入れる。

    Args:
        conn (sqlite3.Connection): 書き込み先の接続。
        data (bytes): 元のファイルのバイト列。
        filename (str | None): 元のファイル名。
        expected_hash (str | None): 期待するハッシュ。違えば入れない。

    Returns:
        str: 入れた音声のハッシュ。

    Raises:
        BunriFileError: ハッシュが期待と違う場合。
    """
    blob = encode_audio(data, filename)
    if expected_hash is not None and blob["hash"] != expected_hash:
        raise BunriFileError("音声の中身がハッシュと合いません")
    _insert_blob(conn, blob)
    return blob["hash"]


def audio_hashes_in(path):
    """ファイルが持っている音声のハッシュの集合（v1 なら空）。"""
    target = Path(path)
    if not target.exists():
        return set()
    conn = _connect(target)
    try:
        if "hash" not in _table_columns(conn, "audio_blobs"):
            return set()
        return {row[0] for row in conn.execute("SELECT hash FROM audio_blobs").fetchall()}
    finally:
        conn.close()


def read_audio(path, hash_):
    """ファイルが持っている音声を 1 つ、画面が読める形で返す（無ければ None）。

    Args:
        path (str | pathlib.Path): `.bunri` ファイル。
        hash_ (str): 音声のハッシュ。

    Returns:
        tuple[bytes, str, str] | None: ``(バイト列, メディアタイプ, 拡張子)``。
    """
    if not is_audio_hash(hash_):
        return None
    conn = _connect(Path(path))
    try:
        if "hash" not in _table_columns(conn, "audio_blobs"):
            return None
        return _read_blob(conn, hash_)
    finally:
        conn.close()


def read_project(path):
    """`.bunri` を、プロジェクトの文書（API でやり取りする JSON の形）にして返す。

    v2 のプロジェクトはそのまま。カルテだけのファイル（v1、または ``/api/chart`` が作ったもの）は、
    カルテと「原曲」のトラック 1 本のプロジェクトとして返す（元音声が在ればクリップにする）。
    音声はハッシュで指す（中身は ``read_audio`` で取る）。カルテの元音声を ``audio_blobs`` に
    移していないファイルは、先に ``migrate`` を通すこと。

    Args:
        path (str | pathlib.Path): `.bunri` ファイル。

    Returns:
        dict: プロジェクトの文書。``cached`` に、入っていたガイドと説明の写しの一覧
        （``[{"kind", "key", "entry"}]``）を足してある。

    Raises:
        BunriFileError: ファイルが無い、bunri 形式でない、または新しすぎる場合。
    """
    import json

    target = Path(path)
    if not target.exists():
        raise BunriFileError(f".bunri ファイルが見つかりません: {path}")
    conn = _connect(target)
    try:
        _check_version(conn)
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        project = conn.execute("SELECT * FROM project WHERE id = 1").fetchone() if "project" in tables else None
        has_chart = "charts" in tables and conn.execute(
            "SELECT 1 FROM charts WHERE id = ?", (CHART_ID,)).fetchone() is not None
        chart = None
        if has_chart:
            conn.close()
            chart_dict = read_chart(target)
            conn = _connect(target)
            audio_row = conn.execute("SELECT * FROM chart_audio WHERE chart_id = ?", (CHART_ID,)).fetchone()
            audio = audio_row["audio_hash"] if audio_row is not None and "audio_hash" in audio_row.keys() else None
            chart = {"chartId": None, "chart": chart_dict, "audio": audio,
                     "audioName": audio_row["filename"] if audio_row is not None else None, "peaks": None}

        state = {}
        if "project_state" in tables:
            for row in conn.execute("SELECT section, json FROM project_state").fetchall():
                try:
                    value = json.loads(row["json"])
                except ValueError:
                    continue
                if isinstance(value, dict):
                    state[row["section"]] = value
        view = state.pop("chart_view", None)
        if chart is not None and view:
            chart["chartId"] = view.get("chartId")
            chart["peaks"] = view.get("peaks")

        if project is None:
            return _chart_only_document(conn, target, chart, state)

        doc = {
            "version": DOCUMENT_VERSION,
            "meta": {
                "name": project["name"] or target.stem, "createdAt": project["created_at"],
                "modifiedAt": project["modified_at"], "uuid": project["uuid"],
                "appVersion": _meta_value(conn, "app_version"),
            },
            "grid": {"bpm": project["bpm"], "beatsPerBar": project["beats_per_bar"],
                     "gridOffset": project["grid_offset_sec"] or 0.0},
            "tracks": _read_tracks(conn),
            "chart": chart,
            "state": state,
            "history": _read_history(conn),
            "cached": _read_cached(conn),
        }
        return doc
    finally:
        conn.close()


def _meta_value(conn, key):
    """``bunri_meta`` の値を 1 つ読む（無ければ None）。"""
    row = conn.execute("SELECT value FROM bunri_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _chart_only_document(conn, target, chart, state):
    """カルテだけのファイルを、プロジェクトの文書の形にする。"""
    tracks = []
    if chart is not None and chart.get("audio"):
        row = conn.execute("SELECT sample_rate, frames FROM audio_blobs WHERE hash = ?", (chart["audio"],)).fetchone()
        duration = (row["frames"] / row["sample_rate"]) if row and row["sample_rate"] and row["frames"] else 0.0
        tracks.append({
            "name": "原曲", "role": "song", "part": None, "practiceOf": None,
            "gain": 0.0, "pan": 0.0, "mute": False, "solo": False, "notes": [], "referenceNotes": None,
            "clips": [{"name": chart.get("audioName") or "原曲", "offset": 0.0, "duration": duration,
                       "audio": chart["audio"]}],
            "extra": {},
        })
    grid = (chart or {}).get("chart", {}).get("grid") or {}
    sig = grid.get("time_signature") or [4, 4]
    beats = grid.get("beat_times_sec") or []
    return {
        "version": DOCUMENT_VERSION,
        "meta": {"name": target.stem, "createdAt": None, "modifiedAt": None, "uuid": None,
                 "appVersion": _meta_value(conn, "app_version")},
        "grid": {"bpm": grid.get("bpm") or 120.0, "beatsPerBar": int(sig[0] or 4),
                 "gridOffset": float(grid.get("downbeat_offset_sec") or (beats[0] if beats else 0.0) or 0.0)},
        "tracks": tracks,
        "chart": chart,
        "state": state,
        "history": [],
        "cached": [],
    }


def _read_tracks(conn):
    """トラック・ノート・クリップを読む。"""
    import json

    notes = {}
    # 強さの列は後から足した。それより前に保存したファイルには無いので、在るときだけ読む
    has_velocity = "velocity" in _table_columns(conn, "project_notes")
    for row in conn.execute(
        f"SELECT track_position, kind, note, octave, step, length{', velocity' if has_velocity else ''} FROM project_notes "
        "ORDER BY track_position, kind, position"
    ).fetchall():
        note = {"note": row["note"], "octave": row["octave"], "step": row["step"], "length": row["length"]}
        # 強さを持たないノートには、項目そのものを付けない (画面の側が、既定の強さとして扱う)
        if has_velocity and row["velocity"] is not None:
            note["velocity"] = row["velocity"]
        notes.setdefault((row["track_position"], row["kind"]), []).append(note)
    clips = {}
    for row in conn.execute(
        "SELECT track_position, name, offset_sec, duration_sec, audio_hash FROM project_clips "
        "ORDER BY track_position, position"
    ).fetchall():
        clips.setdefault(row["track_position"], []).append(
            {"name": row["name"], "offset": row["offset_sec"], "duration": row["duration_sec"],
             "audio": row["audio_hash"]})
    tracks = []
    for row in conn.execute("SELECT * FROM project_tracks ORDER BY position").fetchall():
        pos = row["position"]
        try:
            extra = json.loads(row["extra"]) if row["extra"] else {}
        except ValueError:
            extra = {}
        tracks.append({
            "name": row["name"], "role": row["role"], "part": row["part"], "practiceOf": row["practice_of"],
            "gain": row["gain_db"], "pan": row["pan"], "mute": bool(row["mute"]), "solo": bool(row["solo"]),
            "notes": notes.get((pos, "notes"), []),
            "referenceNotes": notes.get((pos, "reference"), []) if row["has_reference"] else None,
            "clips": clips.get(pos, []),
            "extra": extra if isinstance(extra, dict) else {},
        })
    return tracks


def _read_history(conn):
    """学習の記録を、記録した順に読む。"""
    rows = conn.execute("SELECT * FROM learning_history ORDER BY id").fetchall()
    return [
        {
            "recordedAt": row["recorded_at"], "referenceTrack": row["reference_track"],
            "attemptTrack": row["attempt_track"], "part": row["part"],
            "startBar": row["start_bar"], "endBar": row["end_bar"],
            "referenceCount": row["reference_count"], "matched": row["matched"], "matchRate": row["match_rate"],
            "counts": {kind: row[kind] for kind in _HISTORY_KINDS},
            "explanationId": row["explanation_id"],
        }
        for row in rows
    ]


def _read_cached(conn):
    """ガイドと説明の写しを読む。"""
    import json

    out = []
    for row in conn.execute("SELECT kind, key, json FROM cached_results ORDER BY kind, key").fetchall():
        try:
            entry = json.loads(row["json"])
        except ValueError:
            continue
        if isinstance(entry, dict):
            out.append({"kind": row["kind"], "key": row["key"], "entry": entry})
    return out
