"""v4.14.8 — Catalog visibility diagnostics tests."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.catalog_coverage_diagnostics import (
    diagnose_catalog_visibility,
    format_diagnosis,
)
from app.tests.test_v4148_shopify_catalog_scanner import _active_product, _draft_product


@pytest.mark.asyncio
async def test_no_active_exact_match():
    draft = _draft_product()
    with patch(
        "app.agent_runtime.catalog_coverage_diagnostics.scan_products_by_query",
        new=AsyncMock(return_value=[]),
    ), patch(
        "app.agent_runtime.catalog_coverage_diagnostics.deep_search_term",
        new=AsyncMock(return_value=[draft]),
    ), patch(
        "app.agent_runtime.catalog_coverage_diagnostics.scan_variants_by_query",
        new=AsyncMock(return_value=[]),
    ):
        report = await diagnose_catalog_visibility("USA Today")
    assert len(report.exact_active) == 0
    assert len(report.draft_archived) == 1
    assert report.orderable_via_api is False
    assert "draft" in report.likely_issue.lower()


@pytest.mark.asyncio
async def test_active_orderable_match():
    active = _active_product()
    with patch(
        "app.agent_runtime.catalog_coverage_diagnostics.scan_products_by_query",
        new=AsyncMock(return_value=[active]),
    ), patch(
        "app.agent_runtime.catalog_coverage_diagnostics.deep_search_term",
        new=AsyncMock(return_value=[active]),
    ), patch(
        "app.agent_runtime.catalog_coverage_diagnostics.scan_variants_by_query",
        new=AsyncMock(return_value=[]),
    ):
        report = await diagnose_catalog_visibility("USA Today")
    assert report.orderable_via_api is True


def test_format_diagnosis():
    from app.agent_runtime.catalog_coverage_diagnostics import CatalogCoverageReport

    text = format_diagnosis(CatalogCoverageReport(
        search_term="USA Today",
        likely_issue="No match",
        recommended_shopify_fix="Add product",
    ))
    assert "USA Today" in text
    assert "likely issue" in text
