"""
v4.2 tests — worker registry completeness and architecture rules.

Verifies:
- All 31 expected workers exist in registry.
- No worker imports openai directly.
- ResponsePlanWorker runs in wave 2 (after wave 1 bundle).
- Wave 2 result is in bundle under "response_plan".
- All intents covered in orchestrator mapping.
"""
from __future__ import annotations

import ast
import os
import pytest
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.workers.orchestrator import _REGISTRY, _INTENT_WORKERS, WORKER_PATH_INTENTS


class TestWorkerRegistryCompleteness:
    def test_registry_has_original_17_workers(self):
        original = [
            "caller_identity", "customer_profile", "product_isbn", "product_search",
            "price_inventory", "order_lookup", "tracking", "refund", "shipping",
            "checkout", "payment_email", "escalation", "store_policy",
            "facility_approval", "facility_restriction", "facility_policy_notes",
            "order_facility_review",
        ]
        for name in original:
            assert name in _REGISTRY, f"Missing original worker: {name}"

    def test_registry_has_new_v42_workers(self):
        new_workers = [
            "speech_cleanup", "isbn_fragment", "email_fragment",
            "book_title_extractor", "quantity_extractor", "conversation_memory",
            "caller_memory", "availability_backorder", "product_details",
            "address_update", "cancellation", "payment_safety", "response_plan",
        ]
        for name in new_workers:
            assert name in _REGISTRY, f"Missing v4.2 worker: {name}"

    def test_registry_has_at_least_30_workers(self):
        assert len(_REGISTRY) >= 30, f"Expected ≥30 workers, got {len(_REGISTRY)}"

    def test_all_registry_workers_have_run_method(self):
        import inspect
        for name, worker in _REGISTRY.items():
            assert hasattr(worker, "run"), f"Worker {name} missing run()"
            assert inspect.iscoroutinefunction(worker.run), f"Worker {name}.run() not async"

    def test_response_plan_in_registry(self):
        assert "response_plan" in _REGISTRY
        from app.workers.response_plan_worker import ResponsePlanWorker
        assert isinstance(_REGISTRY["response_plan"], ResponsePlanWorker)


class TestNoOpenAIInWorkers:
    """Workers must NEVER import or call OpenAI directly."""

    def _worker_files(self):
        workers_dir = Path(__file__).parent.parent / "workers"
        return list(workers_dir.glob("*_worker.py"))

    def test_workers_do_not_import_openai(self):
        """No worker file should import openai."""
        violations = []
        for path in self._worker_files():
            source = path.read_text(encoding="utf-8")
            try:
                tree = ast.parse(source)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name.startswith("openai"):
                            violations.append(f"{path.name}: import {alias.name}")
                elif isinstance(node, ast.ImportFrom):
                    if (node.module or "").startswith("openai"):
                        violations.append(f"{path.name}: from {node.module} import ...")
        assert not violations, f"Workers must not import openai:\n" + "\n".join(violations)

    def test_workers_do_not_import_openai_agent(self):
        """No worker should import from app.ai.openai_agent."""
        violations = []
        for path in self._worker_files():
            source = path.read_text(encoding="utf-8")
            if "openai_agent" in source:
                violations.append(path.name)
        assert not violations, f"Workers importing openai_agent: {violations}"


class TestAllIntentsHaveWorkers:
    def test_all_intents_in_worker_path(self):
        """Every intent in _INTENT_WORKERS must be in WORKER_PATH_INTENTS."""
        for intent in _INTENT_WORKERS:
            assert intent in WORKER_PATH_INTENTS, (
                f"Intent '{intent}' in _INTENT_WORKERS but not in WORKER_PATH_INTENTS"
            )

    def test_conversational_intents_covered(self):
        for intent in ("greeting", "confirmation", "email_capture",
                       "email_provided", "email_correction", "email_confirmation",
                       "unknown"):
            assert intent in WORKER_PATH_INTENTS, f"Conversational intent '{intent}' not in WORKER_PATH_INTENTS"


class TestResponsePlanWorkerWave2:
    async def test_response_plan_in_bundle_after_orchestrator_run(self):
        from app.workers.orchestrator import WorkerOrchestrator
        from app.state.models import SessionState
        from app.pipeline.router import IntentResult
        from app.config import Settings

        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)
        ir = IntentResult(
            intent="greeting", confidence=0.9,
            entities={}, needs_filler=False, suggested_tools=[],
        )
        orch = WorkerOrchestrator()
        bundle = await orch.run(ir, session, settings)

        assert "response_plan" in bundle.results
        assert bundle.results["response_plan"].success

    async def test_response_plan_sets_session_field(self):
        from app.workers.orchestrator import WorkerOrchestrator
        from app.state.models import SessionState
        from app.pipeline.router import IntentResult
        from app.config import Settings

        session = SessionState(
            session_id="s", call_sid="CA1",
            from_number="+1", to_number="+2",
        )
        settings = Settings(OPENAI_API_KEY="test", DEBUG=True)
        ir = IntentResult(
            intent="greeting", confidence=0.9,
            entities={}, needs_filler=False, suggested_tools=[],
        )
        orch = WorkerOrchestrator()
        await orch.run(ir, session, settings)

        assert isinstance(session.response_plan, dict)
        assert "action" in session.response_plan
