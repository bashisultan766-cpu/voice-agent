"""v4.14.9 — Commerce tools inventory tests."""
from __future__ import annotations

import importlib.util
import io
import os
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _run_script_main(module_path: Path) -> tuple[int, str, str]:
    spec = importlib.util.spec_from_file_location(module_path.stem, module_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = mod.main()
    return code, buf.getvalue(), ""


class TestCommerceToolsInventory:
    def test_inventory_script_lists_workers(self):
        script = ROOT / "scripts" / "report_commerce_tools_inventory.py"
        code, out, _ = _run_script_main(script)
        assert code == 0
        assert "universal_catalog_search" in out
        assert "product_isbn" in out
        assert "order_lookup" in out
        assert "refund" in out
        assert "facility_approval" in out
        assert "cart_mutation" in out
        assert "payment_flow" in out
        assert "PaymentSafetyGuard" in out
        assert "status=OK" in out

    def test_no_secrets_in_inventory_output(self):
        script = ROOT / "scripts" / "report_commerce_tools_inventory.py"
        _, out, _ = _run_script_main(script)
        assert "sk-" not in out
        assert "@gmail.com" not in out
