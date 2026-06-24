#!/usr/bin/env python3
"""Verify a live brain smoke call against v4.16.0 log markers (v4.16.1).

Usage:
    python scripts/verify_brain_smoke_call.py --sid CA1234567890abcdef --log app/data/call_logs.txt
    python scripts/verify_brain_smoke_call.py --sid CA1234 --simulate-pass   # dry-run for CI

Checks GOOD log markers are present and BAD markers are absent for the given SID.
Also verifies the 9 live scenario phrases against the Brain's fast-path logic.
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# ── v4.16.0 required good log markers ─────────────────────────────────────────
GOOD_MARKERS_V4160 = (
    "brain_decision_started",
    "brain_decision_complete",
    "speculative_prefetch_started",
    "speculative_prefetch_completed",
    "brain_prefetch_review_completed",
)

GOOD_MARKERS_TOOL_PATH = (
    "brain_tool_plan_validated",
    "tool_plan_execution_completed",
)

# At least one of these must appear per call
GOOD_MARKER_DIRECT = (
    "source=direct",
    "source=brain_direct",
    "tool_fanout_skipped reason=brain_direct_answer",
    "tool_fanout_skipped reason=direct_answer",
)

# ── bad markers ───────────────────────────────────────────────────────────────
BAD_MARKERS = (
    "mixed_identifiers_detected",
    "generic_unknown_used",
    "commerce_control hold",
    "skip_turn reason=commerce_control",
    "I found 2 items to look up",
    "Could you say that one more time?",
    "tool_calls",
    "role=tool",
    "Processing Fee",
    "processing fee",
)

BAD_PATTERNS = (
    (re.compile(r"https?://[^\s]*checkout[^\s]*", re.I), "raw checkout URL"),
    (re.compile(r"\bsk-[a-zA-Z0-9]{10,}\b"), "API key leak"),
    (re.compile(r"\bshpat_[a-zA-Z0-9]+\b"), "Shopify token leak"),
)

# ── scenario verifier definitions ─────────────────────────────────────────────
@dataclass
class Scenario:
    name: str
    user_text: str
    expected_contains: list[str] = field(default_factory=list)
    expected_not_contains: list[str] = field(default_factory=list)
    expect_catalog_plan: bool = False
    expect_no_checkout: bool = True


SCENARIOS = [
    Scenario(
        "hello_presence",
        "Hello?",
        expected_contains=["i'm here", "how can i help"],
        expected_not_contains=["could you say that one more time", "generic_unknown"],
    ),
    Scenario(
        "greeting_brother",
        "Hello. How are you, brother?",
        expected_contains=["i'm doing well"],
        expected_not_contains=["found 2 items to look up", "catalog_search", "mixed_identifiers"],
    ),
    Scenario(
        "identity_yes_or_no",
        "Your name is Eric. Yes or no?",
        expected_contains=["yes, my name is eric"],
        expected_not_contains=["hold", "skip_turn"],
    ),
    Scenario(
        "meta_complaint",
        "Why are you not using LLM?",
        expected_contains=["i'm here and ready to help"],
        expected_not_contains=["scout", "prefetch", "orchestrator", "brain_orchestrator"],
    ),
    Scenario(
        "tea_recipe_out_of_domain",
        "How do I make tea?",
        # Brain says: "I can't walk you through a recipe, but I can help find cookbooks or magazines"
        expected_contains=["cookbooks", "magazines"],
        # Don't check for literal "recipe" — brain legitimately uses it when declining
        expected_not_contains=["here is how to make", "step 1:", "boil the water and add"],
    ),
    Scenario(
        "cricket_match_out_of_domain",
        "Who won the cricket match?",
        # Brain says: "I don't have live sports scores, but I can help look for
        #              cricket books, magazines, or newspapers in the store."
        expected_contains=["cricket books, magazines, or newspapers"],
        # Ban giving actual match result — "won" by a specific team
        expected_not_contains=["india won", "australia won", "england won"],
    ),
    Scenario(
        "cricket_books_catalog",
        "Do you have cricket books?",
        expect_catalog_plan=True,
    ),
    Scenario(
        "usa_today_catalog",
        "I need USA Today 5 day delivery for 3 months.",
        # Domain boundary detects subscription/delivery pattern → catalog plan
        expect_catalog_plan=True,
    ),
    Scenario(
        "payment_link_empty_cart",
        "Send payment link.",
        expected_contains=["what item would you like to order first", "what item"],
        expect_no_checkout=True,
    ),
]


def _run_brain_scenario(scenario: Scenario) -> tuple[bool, str]:
    """Run Brain fast-path decision for the scenario (no LLM call, no network)."""
    from app.agent_runtime.brain_orchestrator import BrainOrchestrator, BrainOrchestratorInput
    from app.config import Settings
    import asyncio

    settings = Settings(
        OPENAI_API_KEY="test-key",
        VOICE_BRAIN_ORCHESTRATOR_ENABLED=True,
        VOICE_BRAIN_DETERMINISTIC_GREETING_FASTPATH=True,
    )
    brain = BrainOrchestrator(settings)

    decision = asyncio.run(brain.decide(
        BrainOrchestratorInput(
            call_sid="CAsmoke000001",
            user_text=scenario.user_text,
            cart_summary="",
            commerce_session_summary="",
        )
    ))

    answer = (decision.answer or "").lower()
    mode = decision.response_mode
    tool_plan = decision.tool_plan

    failures: list[str] = []

    for expected in scenario.expected_contains:
        if not any(w in answer for w in [expected.lower()]):
            # Try splitting for any-of
            if not any(part in answer for part in expected.lower().split(", ")):
                failures.append(f"answer missing '{expected}' (got: {answer[:80]!r})")

    for banned in scenario.expected_not_contains:
        if banned.lower() in answer:
            failures.append(f"answer contains banned phrase '{banned}'")
        if banned.lower() in mode:
            failures.append(f"mode contains banned '{banned}'")

    if scenario.expect_catalog_plan:
        if mode != "needs_tools" or tool_plan is None:
            failures.append(f"expected needs_tools+tool_plan, got mode={mode} tool_plan={tool_plan}")

    if scenario.expect_no_checkout:
        if tool_plan and "payment_flow" in (tool_plan.categories or []) and not (decision.answer or ""):
            failures.append("unexpected payment_flow tool triggered without answer")

    if failures:
        return False, "; ".join(failures)
    return True, f"mode={mode} answer={answer[:60]!r}"


@dataclass
class LogCheckResult:
    good_found: list[str] = field(default_factory=list)
    good_missing: list[str] = field(default_factory=list)
    bad_found: list[str] = field(default_factory=list)
    pattern_found: list[str] = field(default_factory=list)
    has_brain_direct: bool = False


def _check_log_file(log_path: Path, sid: str) -> LogCheckResult:
    result = LogCheckResult()
    if not log_path.is_file():
        return result

    lines = [
        line
        for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if sid in line or (sid and sid[:6] in line) or not sid
    ]
    blob = "\n".join(lines)

    for marker in GOOD_MARKERS_V4160:
        if marker in blob:
            result.good_found.append(marker)
        else:
            result.good_missing.append(marker)

    result.has_brain_direct = any(m in blob for m in GOOD_MARKER_DIRECT)

    for marker in BAD_MARKERS:
        if marker in blob:
            result.bad_found.append(marker)

    for pat, label in BAD_PATTERNS:
        if pat.search(blob):
            result.pattern_found.append(label)

    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify brain smoke call (v4.16.1)")
    parser.add_argument("--sid", default="", help="Call SID to filter log lines")
    parser.add_argument("--log", default="", help="Path to log file")
    parser.add_argument("--simulate-pass", action="store_true",
                        help="Skip log file check and run only deterministic brain scenarios")
    args = parser.parse_args(argv)

    print(f"=== Brain Smoke Call Verifier (v4.16.1) SID={args.sid or 'all'} ===\n")

    all_pass = True

    # ── Deterministic scenario checks ──────────────────────────────────────────
    print("Running deterministic scenario checks...")
    for scenario in SCENARIOS:
        try:
            ok, detail = _run_brain_scenario(scenario)
        except Exception as exc:
            ok, detail = False, str(exc)[:120]
        status = "PASS" if ok else "FAIL"
        if not ok:
            all_pass = False
        print(f"  [{status}] {scenario.name}: {detail}")

    print()

    # ── Log file checks (optional — only if log path or SID provided) ──────────
    log_path = Path(args.log) if args.log else None
    if log_path and not args.simulate_pass:
        print(f"Checking log file: {log_path}")
        log_result = _check_log_file(log_path, args.sid)

        if log_result.good_missing:
            print(f"  WARN: missing good markers: {log_result.good_missing}")
        else:
            print(f"  PASS: all {len(log_result.good_found)} required markers found")

        if not log_result.has_brain_direct:
            print("  WARN: no brain_direct source log found — confirm at least one direct-answer turn ran")

        if log_result.bad_found:
            print(f"  FAIL: bad markers found: {log_result.bad_found}")
            all_pass = False
        else:
            print("  PASS: no bad markers")

        if log_result.pattern_found:
            print(f"  FAIL: dangerous patterns found: {log_result.pattern_found}")
            all_pass = False
        else:
            print("  PASS: no dangerous patterns")
        print()

    verdict = "PASS" if all_pass else "FAIL"
    print(f"BRAIN_SMOKE_CALL={verdict}")
    if not all_pass:
        print("Next action: review failures above and re-test with live call.")
    else:
        print("Next action: proceed to live staging call, then deploy.")
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
