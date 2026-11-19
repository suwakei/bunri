"""bunri同梱版はCPU/MPSのPyTorch推論だけを使う。"""


def use_coreml(backend, device, config_path, checkpoint_path):
    """上流の呼出形を保ち、Core MLの依存を読み込まない。"""
    if backend not in {"auto", "torch"}:
        raise ValueError("同梱版の分離はPyTorchで実行してください")
    return False


def load_coreml_separator(*args, **kwargs):
    """この配布物に含めていない実行基盤を拒否する。"""
    raise ValueError("同梱版の分離はPyTorchで実行してください")
