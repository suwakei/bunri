"""
bunri DAW — `.bunri` ドキュメントファイル（SQLite ベース）

1ファイル = 1曲のプロジェクトドキュメント。CLIP STUDIO の ``.clip`` や
Ableton の ``.als`` と同じ思想で、ユーザーが持ち運べる単一ファイルとして
カルテと元音声を保持する。

v1 の範囲はカルテ関連テーブルのみ。トラック・ノート・進捗は第2弾以降で
テーブルを追加する。投機的にスキーマを切らないのは、実際に作るときに
ほぼ確実に作り直しになるため。

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
FORMAT_VERSION = "1.0"

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
    data          BLOB
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


def create(path, chart, audio_path=None, embed_audio=True, app_version="0.1.0"):
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
        if audio_path is not None:
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
        conn.executescript(_SCHEMA)
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

    Raises:
        BunriFileError: ``bunri_meta`` が存在しない場合。
        BunriFileError: メジャーバージョンが自分より新しい場合。
    """
    try:
        row = conn.execute("SELECT value FROM bunri_meta WHERE key = 'format_version'").fetchone()
    except sqlite3.OperationalError as e:
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
            "SELECT filename, embedded, external_path, data FROM chart_audio WHERE chart_id = ?",
            (CHART_ID,),
        ).fetchone()
        if row is None:
            return None

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
