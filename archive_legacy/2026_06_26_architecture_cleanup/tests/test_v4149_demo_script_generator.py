"""v4.14.9 — Demo script generator tests."""
from __future__ import annotations

import io
import importlib.util
import os
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _run_script(path: Path) -> tuple[int, str]:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = mod.main()
    return code, buf.getvalue()


class TestDemoScriptGenerator:
    def test_generator_outputs_markers(self):
        script = ROOT / "scripts" / "generate_live_demo_script.py"
        code, out = _run_script(script)
        assert code == 0
        assert "MARKER: demo_script_v4149_complete" in out
        assert "ISBN search" in out or "Book ISBN search" in out
        assert "Multiple payment groups" in out
        assert "Email spellback" in out
        assert "Order lookup route" in out
        assert "Facility rule route" in out
        assert "Step 13" in out

    def test_no_secrets_in_demo_script(self):
        script = ROOT / "scripts" / "generate_live_demo_script.py"
        _, out = _run_script(script)
        assert "sk-" not in out
        assert "re_" not in out.lower() or "Resend" in out
