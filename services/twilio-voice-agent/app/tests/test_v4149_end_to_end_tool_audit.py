"""v4.14.9 — End-to-end tool audit tests."""
from __future__ import annotations

import io
import importlib.util
import os
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")

ROOT = Path(__file__).resolve().parents[2]


def _load_audit_module():
    import sys

    path = ROOT / "scripts" / "audit_end_to_end_commerce_flows.py"
    spec = importlib.util.spec_from_file_location("audit_e2e", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class TestEndToEndToolAudit:
    def test_audit_matrix_runs(self):
        mod = _load_audit_module()
        buf = io.StringIO()
        with redirect_stdout(buf):
            mod.main()
        out = buf.getvalue()
        assert "A_book_isbn" in out
        assert "K_order_lookup" in out
        assert "L_refund" in out
        assert "M_facility" in out
        assert "I_payment_single" in out

    def test_audit_order_refund_facility_ok(self):
        mod = _load_audit_module()

        assert mod.audit_order_lookup().status == "OK"
        assert mod.audit_refund().status == "OK"
        assert mod.audit_facility().status == "OK"

    def test_run_all_audits_from_tool_audit_runner(self):
        from app.agent_runtime.tool_audit_runner import run_all_audits

        results = run_all_audits()
        assert all(r.ok for r in results)
