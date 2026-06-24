"""v4.16.1 — Catalog index readiness tests."""
from __future__ import annotations

import io
import os
from contextlib import redirect_stdout
from pathlib import Path

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


def _load_verify_script():
    import importlib.util, sys
    path = Path(__file__).resolve().parents[2] / "scripts" / "verify_catalog_index_ready.py"
    spec = importlib.util.spec_from_file_location("verify_catalog_index_ready", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["verify_catalog_index_ready"] = mod
    spec.loader.exec_module(mod)
    return mod


class TestCatalogIndexReadiness:
    def test_pass_when_index_has_products(self, tmp_path: Path, monkeypatch):
        from app.integrations.shopify_catalog_indexer import CatalogIndexEntry, ShopifyCatalogIndexer
        import app.integrations.shopify_catalog_indexer as idx_mod

        indexer = ShopifyCatalogIndexer(index_path=tmp_path / "index.json")
        entries = [
            CatalogIndexEntry(
                product_id="p1", variant_id="v1",
                title="USA Today 5 Day Delivery 3 Months",
                product_kind="newspaper",
                normalized_terms=["usa", "today", "delivery", "months", "newspaper"],
                available_for_sale=True,
            ),
            CatalogIndexEntry(
                product_id="p2", variant_id="v2",
                title="People Magazine",
                product_kind="magazine",
                normalized_terms=["people", "magazine"],
                available_for_sale=True,
            ),
        ]
        indexer.save_entries(entries)
        monkeypatch.setattr(idx_mod, "DEFAULT_INDEX_PATH", tmp_path / "index.json")

        mod = _load_verify_script()
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main()
        output = buf.getvalue()
        assert "CATALOG_INDEX_READY=PASS" in output
        assert code == 0

    def test_warn_when_empty_but_shopify_configured(self, tmp_path: Path, monkeypatch):
        from app.config import Settings
        import app.integrations.shopify_catalog_indexer as idx_mod

        monkeypatch.setattr(idx_mod, "DEFAULT_INDEX_PATH", tmp_path / "no_index.json")
        test_settings = Settings(
            OPENAI_API_KEY="test-key",
            SHOPIFY_SHOP_DOMAIN="test.myshopify.com",
            SHOPIFY_ADMIN_ACCESS_TOKEN="shpat_test",
        )
        monkeypatch.setattr("app.config.get_settings", lambda: test_settings)

        mod = _load_verify_script()
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main()
        output = buf.getvalue()
        assert "CATALOG_INDEX_READY=WARN" in output
        assert code == 0

    def test_fail_when_empty_and_no_shopify(self, tmp_path: Path, monkeypatch):
        from app.config import Settings
        import app.integrations.shopify_catalog_indexer as idx_mod

        monkeypatch.setattr(idx_mod, "DEFAULT_INDEX_PATH", tmp_path / "no_index.json")
        test_settings = Settings(
            OPENAI_API_KEY="test-key",
            SHOPIFY_SHOP_DOMAIN="",
            SHOPIFY_ADMIN_ACCESS_TOKEN="",
        )
        monkeypatch.setattr("app.config.get_settings", lambda: test_settings)

        mod = _load_verify_script()
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main()
        output = buf.getvalue()
        assert "CATALOG_INDEX_READY=FAIL" in output
        assert code == 1

    def test_search_script_allow_empty_exits_zero(self):
        import importlib.util, sys, io
        from contextlib import redirect_stdout
        from pathlib import Path
        root = Path(__file__).resolve().parents[2]
        path = root / "scripts" / "search_catalog_index.py"
        spec = importlib.util.spec_from_file_location("search_ci", path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules["search_ci"] = mod
        spec.loader.exec_module(mod)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(["--query", "USA Today", "--allow-empty"])
        assert code == 0, f"search --allow-empty exited {code}: {buf.getvalue()}"

    def test_inspect_script_runs_cleanly(self):
        import importlib.util, sys, io
        from contextlib import redirect_stdout
        from pathlib import Path
        root = Path(__file__).resolve().parents[2]
        path = root / "scripts" / "inspect_shopify_catalog_index.py"
        spec = importlib.util.spec_from_file_location("inspect_ci", path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        sys.modules["inspect_ci"] = mod
        spec.loader.exec_module(mod)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main()
        output = buf.getvalue()
        assert code == 0, f"inspect exited {code}: {output}"
        assert "CATALOG_INDEX" in output
        assert "products=" in output
