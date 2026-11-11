"""bunri DAW — Web版起動スクリプト（リポジトリ直下から起動するための入口）

本体は ``backend/run_web.py``。Python のコードは ``backend/`` にまとまっているので、
ここでは ``backend/`` を import パスに足して本体をそのまま実行するだけ。
``python run_web.py`` という従来の起動方法を保つために置いている。
"""
import runpy
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent / "backend"

if __name__ == "__main__":
    sys.path.insert(0, str(BACKEND_DIR))
    runpy.run_path(str(BACKEND_DIR / "run_web.py"), run_name="__main__")
