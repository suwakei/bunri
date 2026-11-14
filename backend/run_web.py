"""bunri DAW — API サーバの起動スクリプト

2 通りの起動のされ方がある。

- デスクトップアプリの sidecar: ``python run_web.py --sidecar``。アプリ（Rust）が起動する。
  空きポートで待ち受け、決まったポートを標準出力に 1 行の JSON で知らせ、
  アプリが居なくなったら自分で終わる
- 開発用: ``python run_web.py [--port N]``。API だけを 127.0.0.1 で待ち受ける。
  画面は Vite の開発サーバ（``cd web-ui && npm run dev``）が出し、``/api`` をここへ中継する。
  画面をブラウザで開いて直したり、自動操作でテストしたりするための起動方法
"""
import argparse
import json
import logging
import os
import re
import signal
import socket
import sys
import threading

import uvicorn

# 待ち受けるアドレス。この PC の中からだけ届く
HOST = "127.0.0.1"


def parse_args(argv=None):
    """コマンドライン引数を読む。

    Args:
        argv: 引数のリスト。None なら ``sys.argv[1:]``。

    Returns:
        argparse.Namespace: ``port`` ``sidecar`` を持つ。
        ``port`` は無指定のとき、開発用なら 8000、sidecar なら 0（空きポート）。
    """
    parser = argparse.ArgumentParser(description="bunri DAW の API サーバを起動する")
    parser.add_argument("--port", type=int, default=None, help="待ち受けるポート。0 なら空きポートを OS に選ばせる")
    parser.add_argument(
        "--sidecar",
        action="store_true",
        help="デスクトップアプリから起動されるときのモード。ポートを JSON で標準出力に出し、親が居なくなったら終了する",
    )
    args = parser.parse_args(argv)
    if args.port is None:
        args.port = 0 if args.sidecar else 8000
    return args


def bind_socket(host, port):
    """待ち受け用のソケットを作って返す。

    ポートを Python 側で決めるための関数。起動する側（Rust）が空きポートを選んで渡すと、
    起動までの間に他のプロセスに取られることがある。ここで bind したソケットをそのまま
    uvicorn に渡せば、その隙間が無い。

    listen まで済ませるので、この関数が返った時点で接続は受け付けられる
    （uvicorn が accept を始めるまでは待ち行列に溜まる）。

    Args:
        host: 待ち受けるアドレス。
        port: 待ち受けるポート。0 なら OS が空きポートを選ぶ。

    Returns:
        socket.socket: bind と listen が済んだソケット。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    sock.set_inheritable(True)
    return sock


def announce(port):
    """決まったポートを標準出力に 1 行の JSON で知らせる。

    Args:
        port: 待ち受けているポート番号。

    Side Effects:
        ``{"event": "listening", "port": <port>, "pid": <pid>}`` を標準出力に 1 行で出す。
    """
    print(json.dumps({"event": "listening", "port": port, "pid": os.getpid()}), flush=True)


# 終わる前に、動いているジョブの片付け（子プロセスの停止と、書きかけの出力の削除）を待つ秒数の上限。
# アプリは標準入力を閉じてから 3 秒で kill しに来るので、それより短くする
JOB_SHUTDOWN_TIMEOUT_SEC = 1.5


def _stop_jobs():
    """動いているジョブを止め、書きかけの出力を片付ける。

    ジョブの仕組み（``background_jobs``）がまだ読み込まれていなければ、何もしない。
    片付けに失敗しても、終了は続ける。
    """
    module = sys.modules.get("background_jobs")
    if module is None:
        return
    try:
        module.shutdown(JOB_SHUTDOWN_TIMEOUT_SEC)
    except Exception:
        pass


def _terminate_self():
    """自分と、自分が起動した子プロセス（demucs など）をまとめて終わらせる。"""
    _stop_jobs()
    if hasattr(os, "killpg"):
        try:
            os.killpg(os.getpgrp(), signal.SIGTERM)
        except OSError:
            pass
    os._exit(0)


def watch_parent(stream=None):
    """親（デスクトップアプリ）が居なくなったら自分で終わるための見張りを始める。

    アプリは sidecar の標準入力をパイプで握ったままにする。アプリが終了しても
    異常終了しても、そのパイプは OS が閉じるので、標準入力が EOF になったら
    親が居なくなったと判断できる。OS を問わず同じ仕組みで動く。

    子プロセス（demucs の実行など）を残さないよう、POSIX では自分を新しい
    プロセスグループの先頭にし、終わるときはグループごと終わらせる。

    Args:
        stream: 見張る入力（バイナリ）。None なら ``sys.stdin.buffer``。

    Returns:
        threading.Thread: 見張りのスレッド（デーモン）。
    """
    if stream is None:
        stream = sys.stdin.buffer
    if hasattr(os, "setpgrp"):
        try:
            os.setpgrp()
        except OSError:
            pass

    def _watch():
        try:
            while stream.read(4096):
                pass
        except (OSError, ValueError):
            pass
        _terminate_self()

    thread = threading.Thread(target=_watch, name="parent-watch", daemon=True)
    thread.start()
    return thread


# アクセスログに残さないクエリの値（``<audio src>`` などで URL に載せる API の鍵。access_control.TOKEN_QUERY）
_SECRET_QUERY_RE = re.compile(r"([?&]token=)[^&#\s]*")
# 伏せたあとに置く文字
REDACTED = "***"


def redact_url(text):
    """URL（またはそれを含む文）の中の ``token=…`` の値を伏せる。

    Args:
        text: URL やログの文。

    Returns:
        str: ``?token=abc`` を ``?token=***`` にした文。ほかの部分はそのまま。
    """
    return _SECRET_QUERY_RE.sub(lambda m: m.group(1) + REDACTED, text)


class RedactTokenFilter(logging.Filter):
    """uvicorn のアクセスログから、URL に載った API の鍵（``?token=``）を伏せる。

    ``<audio src>`` と ``<a href download>`` はヘッダを付けられないので、鍵をクエリに載せて送ってくる
    （docs/desktop-architecture.md「API には鍵がかかっている」）。uvicorn は URL をそのままログに出すので、
    ここで伏せる。ログはアプリの出力（ターミナルやログファイル）に残り、ほかの人に見せることがあるため。
    """

    def filter(self, record):
        """ログの引数（uvicorn のアクセスログでは、3 番目が URL）とメッセージの中の鍵を伏せる。

        Args:
            record: ログの 1 件。

        Returns:
            bool: 常に True（ログは捨てない。中身だけ書き換える）。
        """
        if isinstance(record.args, tuple):
            record.args = tuple(redact_url(a) if isinstance(a, str) else a for a in record.args)
        if isinstance(record.msg, str):
            record.msg = redact_url(record.msg)
        return True


def install_log_redaction():
    """uvicorn のアクセスログに、鍵を伏せるフィルタを付ける（何度呼んでも 1 つだけ）。"""
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, RedactTokenFilter) for f in logger.filters):
        logger.addFilter(RedactTokenFilter())


def main(argv=None):
    """引数に従ってサーバを起動する（終了するまで戻らない）。

    待ち受けるのは常に 127.0.0.1。ほかの PC からは届かない。

    Args:
        argv: 引数のリスト。None なら ``sys.argv[1:]``。
    """
    args = parse_args(argv)
    sock = bind_socket(HOST, args.port)
    port = sock.getsockname()[1]

    if args.sidecar:
        watch_parent()
    # 決まったポートは、どちらの起動のされ方でも知らせる（空きポートを選ばせた側が読めるように）
    announce(port)

    config = uvicorn.Config("web.api:app", host=HOST, port=port, reload=False)
    # uvicorn.Config がログの設定を済ませたあとに付ける（先に付けると設定し直しで外れることがあるため）
    install_log_redaction()
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
