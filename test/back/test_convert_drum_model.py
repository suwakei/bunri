"""ドラム分離モデルの変換スクリプト（scripts/convert_drum_model.py）のうち、ヘッダの組み直しのテスト

本物のモデルは使わない（167 MB 在る）。小さな safetensors を書いて確かめる。
見るのは「同じ中身なら、メタデータの並び順が違っても同じバイト列になる」ことと、
「重みのデータ部と値は変えない」こと。
"""
import hashlib
import importlib.util
import json
import struct
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent.parent / "scripts" / "convert_drum_model.py"


@pytest.fixture(scope="module")
def convert_script():
    spec = importlib.util.spec_from_file_location("convert_drum_model", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _file(header, data):
    return struct.pack("<Q", len(header)) + header + data


def _header(metadata_order, tensor_order=("a", "b")):
    """メタデータとテンソルを、指定の並び順で書いたヘッダ（safetensors が書く形）"""
    metadata = {"klass": "demucs.hdemucs.HDemucs", "kwargs": '{"sources": ["bombo"]}', "args": "[]", "license": "MIT"}
    tensors = {
        "a": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]},
        "b": {"dtype": "F32", "shape": [1], "data_offsets": [8, 12]},
    }
    obj = {"__metadata__": {key: metadata[key] for key in metadata_order}}
    obj.update({name: tensors[name] for name in tensor_order})
    return json.dumps(obj, separators=(",", ":")).encode()


class TestCanonicalHeader:
    def test_メタデータの並び順が違っても_同じバイト列になる(self, convert_script):
        one = convert_script.canonical_header(_header(["klass", "kwargs", "args", "license"]))
        other = convert_script.canonical_header(_header(["license", "args", "klass", "kwargs"], tensor_order=("b", "a")))
        assert one == other

    def test_メタデータは名前の昇順_テンソルはデータの順で_値は変えない(self, convert_script):
        source = _header(["license", "klass", "kwargs", "args"], tensor_order=("b", "a"))
        result = json.loads(convert_script.canonical_header(source))
        assert list(result) == ["__metadata__", "a", "b"]
        assert list(result["__metadata__"]) == ["args", "klass", "kwargs", "license"]
        assert list(result["a"]) == ["dtype", "shape", "data_offsets"]
        assert result == json.loads(source)

    def test_長さは8の倍数で_余りは半角の空白で埋める(self, convert_script):
        header = convert_script.canonical_header(_header(["klass", "kwargs", "args", "license"]))
        assert len(header) % 8 == 0
        assert header.rstrip(b" ").endswith(b"}")
        assert set(header[len(header.rstrip(b" ")):]) <= {0x20}

    def test_すでに決まった形なら_そのまま(self, convert_script):
        header = convert_script.canonical_header(_header(["klass", "kwargs", "args", "license"]))
        assert convert_script.canonical_header(header) == header

    @pytest.mark.parametrize("broken", [
        b'{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}',
        b'{"__metadata__":{"n":1}}',
        b'{"__metadata__":{},"a":{"dtype":"F32","shape":[1]}}',
    ])
    def test_想定の形でないヘッダは受け付けない(self, convert_script, broken):
        with pytest.raises(ValueError):
            convert_script.canonical_header(broken)


class TestRewriteHeader:
    def test_ヘッダだけを組み直し_データ部は1バイトも変えない(self, convert_script, tmp_path):
        data = bytes(range(12))
        src, dst = tmp_path / "raw.safetensors", tmp_path / "out.safetensors"
        src.write_bytes(_file(_header(["license", "klass", "kwargs", "args"]) + b"   ", data))
        data_sha = convert_script.rewrite_header(src, dst)

        written = dst.read_bytes()
        (length,) = struct.unpack("<Q", written[:8])
        assert length % 8 == 0
        assert written[8:8 + length] == convert_script.canonical_header(_header(["klass", "kwargs", "args", "license"]))
        assert written[8 + length:] == data
        assert data_sha == hashlib.sha256(data).hexdigest() == convert_script.data_sha256_of(dst)

    def test_並び順の違う2つのファイルから_同じファイルができる(self, convert_script, tmp_path):
        data = bytes(range(12))
        outputs = []
        for i, order in enumerate((["klass", "kwargs", "args", "license"], ["args", "license", "kwargs", "klass"])):
            src, dst = tmp_path / f"raw{i}.safetensors", tmp_path / f"out{i}.safetensors"
            src.write_bytes(_file(_header(order), data))
            convert_script.rewrite_header(src, dst)
            outputs.append(dst.read_bytes())
        assert outputs[0] == outputs[1]

    def test_組み直したファイルは_safetensorsで読めて_中身が同じ(self, convert_script, tmp_path):
        import torch
        from safetensors import safe_open
        from safetensors.torch import save_file

        state = {"w": torch.arange(6, dtype=torch.float16).reshape(2, 3), "b": torch.tensor([1.5, -2.0])}
        metadata = {"klass": "demucs.hdemucs.HDemucs", "args": "[]", "kwargs": '{"sources": ["bombo", "toms"]}', "license": "MIT"}
        raw, out = tmp_path / "raw.safetensors", tmp_path / "out.safetensors"
        save_file(state, str(raw), metadata=metadata)
        convert_script.rewrite_header(raw, out)
        convert_script.verify(out, metadata, state)
        with safe_open(str(out), framework="pt") as f:
            assert f.metadata() == metadata
        assert convert_script.data_sha256_of(out) == convert_script.data_sha256_of(raw)

    def test_中身が違えば_確かめで失敗する(self, convert_script, tmp_path):
        import torch
        from safetensors.torch import save_file

        state = {"w": torch.tensor([1.0, 2.0])}
        path = tmp_path / "m.safetensors"
        save_file(state, str(path), metadata={"license": "MIT"})
        with pytest.raises(ValueError, match="メタデータ"):
            convert_script.verify(path, {"license": "Apache-2.0"}, state)
        with pytest.raises(ValueError, match="重み"):
            convert_script.verify(path, {"license": "MIT"}, {"w": torch.tensor([1.0, 2.5])})
        with pytest.raises(ValueError, match="名前"):
            convert_script.verify(path, {"license": "MIT"}, {"x": torch.tensor([1.0, 2.0])})
