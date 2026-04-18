"""bunri DAW — Web版起動スクリプト"""
import webbrowser
import threading
import uvicorn


def open_browser():
    """デフォルトブラウザで bunri DAW の Web UI を開く。

    固定 URL http://127.0.0.1:8000 をデフォルトブラウザで開く。
    threading.Timer から呼び出されることを前提とし、uvicorn の起動後に
    遅延実行される。

    Side Effects:
        OS のデフォルトブラウザで http://127.0.0.1:8000 を開く。
    """
    webbrowser.open("http://127.0.0.1:8000")


if __name__ == "__main__":
    # uvicorn 起動から 1.5 秒後にブラウザを開く（サーバー起動を待つため）
    threading.Timer(1.5, open_browser).start()
    uvicorn.run("web.api:app", host="127.0.0.1", port=8000, reload=False)
