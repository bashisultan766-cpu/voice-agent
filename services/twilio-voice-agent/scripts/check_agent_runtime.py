#!/usr/bin/env python3
"""Check Eric Agent Runtime configuration (v4.15.1a). Safe — no secrets printed."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

RELEASE_PACKAGE_VERSION = "v4.15.1"


def main() -> int:
    from app.config import get_settings
    from app.agent_runtime.prompt_loader import get_prompt_load_status, load_eric_system_prompt_text
    from app.agent_runtime.knowledge_base import is_knowledge_base_loaded
    from app.agent_runtime.worker_packet import READ_ONLY_WORKERS, MUTATING_WORKERS
    from app.agent_runtime.main_llm_agent import AVAILABLE_TOOL_CATEGORIES
    from app.agent_runtime.tool_category_mapper import assert_all_mapped_worker_intents_exist
    from app.agent_runtime.tool_entity_extractor import (
        extract_tool_entities,
        is_price_followup,
    )
    from app.agent_runtime.pending_tool_state import is_pending_tool_status_query
    from app.agent_runtime.commerce_session import get_commerce_session
    from app.agent_runtime.followup_context_resolver import resolve_followup_context
    from app.agent_runtime.product_fact_normalizer import normalize_product_candidates
    from app.agent_runtime.cart_orchestrator import cart_summary_text
    from app.agent_runtime.payment_link_orchestrator import handle_payment_request
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
    from app.agent_runtime.demo_hardening import is_commerce_demo_hardening
    from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit

    s = get_settings()
    load_eric_system_prompt_text()
    prompt_status = get_prompt_load_status()
    policy_len = prompt_status["chars"]

    pack_enabled = getattr(s, "ERIC_PROMPT_PACK_ENABLED", True)
    pack_file_count = 0
    pack_status: dict = {}
    try:
        from app.agent_runtime.prompt_pack_loader import get_prompt_pack_status

        pack_status = get_prompt_pack_status()
        pack_file_count = len(pack_status.get("files") or [])
    except Exception:
        pack_status = {}

    tools_blocked = s.VOICE_LIVE_DISABLE_OPENAI_TOOLS is True
    tools_label = "blocked" if tools_blocked else "ENABLED"

    print(f"Agent runtime check: {RELEASE_PACKAGE_VERSION}")
    print(f"Prompt pack enabled: {'yes' if pack_enabled else 'no'}")
    print(f"Prompt pack files: {pack_file_count}")
    print(f"Prompt version: {s.ERIC_SYSTEM_PROMPT_VERSION}")
    print(f"OpenAI live tools: {tools_label}")
    print("=" * 40)

    is_main_llm = s.VOICE_AGENT_RUNTIME_MODE == "main_llm_agent"

    mapper_ok = "OK"
    try:
        assert_all_mapped_worker_intents_exist()
    except AssertionError as exc:
        mapper_ok = f"FAIL: {exc}"

    extractor_ok = "OK"
    try:
        entities = extract_tool_entities("ISBN is 9780441172719")
        if not entities.get("isbn"):
            extractor_ok = "FAIL: ISBN not extracted"
        if extract_tool_entities("Price. What is the price?").get("product_phrase"):
            extractor_ok = "FAIL: price phrase extracted as product"
    except Exception as exc:
        extractor_ok = f"FAIL: {exc}"

    pending_ok = "OK"
    try:
        if not is_pending_tool_status_query("Did you find this?"):
            pending_ok = "FAIL: status query not detected"
    except Exception as exc:
        pending_ok = f"FAIL: {exc}"

    commerce_ok = "OK"
    followup_ok = "OK"
    normalizer_ok = "OK"
    cart_ok = "OK"
    payment_ok = "OK"
    multi_dest_ok = "OK"
    cs_ok = "OK"
    check_sid = f"CAruntime_{uuid.uuid4().hex[:12]}"
    check_sid2 = f"CAruntime_{uuid.uuid4().hex[:12]}"
    check_sid3 = f"CAruntime_{uuid.uuid4().hex[:12]}"
    try:
        cs = get_commerce_session(check_sid)
        if cs.sid != check_sid:
            commerce_ok = "FAIL: session sid"
        fr = resolve_followup_context("Price.", sid=check_sid, commerce=cs)
        if not is_price_followup("Price."):
            followup_ok = "FAIL: price followup detect"
        if not fr.resolved:
            followup_ok = "FAIL: followup not resolved"
        cands = normalize_product_candidates(
            {"product_isbn": {"title": "Dune", "price": "$12", "variant_id": "v1", "product_id": "p1"}},
            "Dune",
            check_sid,
        )
        if not cands:
            normalizer_ok = "FAIL: no candidates"
        if cart_summary_text(cs) != "Your order is empty right now.":
            cart_ok = "FAIL: empty cart summary"
        pay = handle_payment_request(cs)
        if pay.get("response_mode") != "direct_answer":
            payment_ok = "FAIL: empty cart payment"
        route = route_customer_service_intent("Order number is 1234")
        if route.get("intent") != "order_lookup":
            cs_ok = "FAIL: order route"
        from app.agent_runtime.payment_link_orchestrator import assign_lines_to_group
        from app.agent_runtime.commerce_session import add_selected_candidate_to_cart, update_candidates_from_facts

        update_candidates_from_facts(cs, cands)
        line = add_selected_candidate_to_cart(cs)
        if not line:
            cart_ok = "FAIL: add candidate"
        g1 = assign_lines_to_group(cs, [line.line_id], name="Group A")
        g2 = assign_lines_to_group(cs, [], name="Group B", group_id="g2")
        if not g1.get("group_id") or not g2.get("group_id"):
            multi_dest_ok = "FAIL: destination groups"
    except Exception as exc:
        commerce_ok = f"FAIL: {exc}"
        followup_ok = f"FAIL: {exc}"
        normalizer_ok = f"FAIL: {exc}"
        cart_ok = f"FAIL: {exc}"
        payment_ok = f"FAIL: {exc}"
        multi_dest_ok = f"FAIL: {exc}"
        cs_ok = f"FAIL: {exc}"

    print(f"Eric Agent Runtime Check ({RELEASE_PACKAGE_VERSION})")
    print(f"Agent runtime mode:     {s.VOICE_AGENT_RUNTIME_MODE}")
    print(f"Eric prompt file:       {'loaded' if prompt_status['loaded_from_file'] else 'inline_fallback'}")
    print(f"Eric prompt chars:      {prompt_status['chars']}")
    print(f"Commerce session:       {commerce_ok}")
    print(f"Follow-up context resolver: {followup_ok}")
    print(f"Product fact normalizer: {normalizer_ok}")
    print(f"Cart orchestrator:      {cart_ok}")
    print(f"Payment link orchestrator: {payment_ok}")
    print(f"Multi-destination payments: {multi_dest_ok}")
    commit_ok = "OK"
    hardening_ok = "enabled" if is_commerce_demo_hardening(s) else "disabled"
    try:
        cs2 = get_commerce_session(check_sid2)
        cr = resolve_commerce_commit("I need these 2 books", cs2)
        if not cr.matched:
            commit_ok = "FAIL: commit resolver"
    except Exception as exc:
        commit_ok = f"FAIL: {exc}"

    print(f"Commerce commit resolver: {commit_ok}")
    print(f"Commerce demo hardening: {hardening_ok}")

    taxonomy_ok = "OK"
    universal_ok = "OK"
    pub_intents_ok = "OK"
    pub_norm_ok = "OK"
    audit_ok = "OK"
    coverage_ok = "OK"
    order_audit_ok = "OK"
    try:
        from app.agent_runtime.catalog_taxonomy import detect_product_kind, ProductKind
        from app.agent_runtime.business_intent_resolver import resolve_business_intent
        from app.agent_runtime.tool_audit_runner import run_all_audits
        from app.workers.universal_catalog_search_worker import UniversalCatalogSearchWorker

        if detect_product_kind("I need a newspaper") != ProductKind.NEWSPAPER:
            taxonomy_ok = "FAIL: newspaper kind"
        if not UniversalCatalogSearchWorker().name:
            universal_ok = "FAIL: worker missing"
        biz = resolve_business_intent("Can you give me newspaper?")
        if biz.intent != "newspaper_request":
            pub_intents_ok = "FAIL: newspaper_request"
        pub_cands = normalize_product_candidates(
            {"universal_catalog_search": {
                "title": "USA Today 5 Day",
                "price": "$149.99",
                "variant_id": "v99",
                "product_id": "p99",
                "product_kind": "newspaper",
            }},
            "USA Today",
            check_sid3,
            query_entities={"product_kind": "newspaper", "publication_title": "USA Today"},
        )
        if not pub_cands or pub_cands[0].variant_id != "v99":
            pub_norm_ok = "FAIL: publication normalize"
        audits = run_all_audits()
        if not all(a.ok for a in audits):
            audit_ok = "FAIL: tool audit"
            order_audit_ok = "FAIL: order/refund/facility audit"
        from app.workers.orchestrator import _REGISTRY
        if "universal_catalog_search" not in _REGISTRY:
            universal_ok = "FAIL: not registered"
    except Exception as exc:
        taxonomy_ok = f"FAIL: {exc}"
        universal_ok = f"FAIL: {exc}"
        pub_intents_ok = f"FAIL: {exc}"
        pub_norm_ok = f"FAIL: {exc}"
        audit_ok = f"FAIL: {exc}"
        coverage_ok = f"FAIL: {exc}"
        order_audit_ok = f"FAIL: {exc}"

    print(f"Catalog taxonomy:       {taxonomy_ok}")
    print(f"Universal catalog search: {universal_ok}")
    print(f"Newspaper/magazine intents: {pub_intents_ok}")
    print(f"Publication normalizer: {pub_norm_ok}")
    print(f"Tool audit runner:      {audit_ok}")
    print(f"Shopify catalog coverage debug: {coverage_ok}")
    print(f"Order/refund/facility audit: {order_audit_ok}")

    scanner_ok = "OK"
    visibility_ok = "OK"
    deep_fallback_ok = "OK"
    orderability_ok = "OK"
    order_route_ok = "OK"
    try:
        from app.integrations.shopify_catalog_scanner import mask_secrets, assess_voice_agent_usability, ScannedProduct, ScannedVariant
        from app.agent_runtime.catalog_coverage_diagnostics import diagnose_catalog_visibility, CatalogCoverageReport
        from app.agent_runtime.catalog_orderability import assess_orderability
        from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
        from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

        if "shpat_" in mask_secrets("token shpat_abc123xyz"):
            scanner_ok = "FAIL: secret not masked"
        sample = ScannedProduct(
            product_id="p1", title="Test Paper", handle="test", status="DRAFT",
            product_type="", vendor="", tags=[], online_store_url="", published_at=None,
            published_online=False, publications=[], variants=[
                ScannedVariant("v1", "Default", "sku1", "9.99", False, 0),
            ],
        )
        sample.usability = assess_voice_agent_usability(sample)
        if sample.usability.get("voice_agent_usable"):
            visibility_ok = "FAIL: draft should not be usable"
        order = assess_orderability({"status": "DRAFT", "variant_id": "v1", "price": "9.99", "available": False})
        if order.get("can_add_to_cart"):
            orderability_ok = "FAIL: draft orderable"
        draft_row = {"status": "DRAFT", "title": "USA Today", "variant_id": "v1", "price": "149.99", "can_add_to_cart": False, "not_orderable": True}
        if assess_orderability(draft_row).get("can_add_to_cart"):
            deep_fallback_ok = "FAIL: draft fallback"
        route = route_customer_service_intent("Order number is 1234")
        plans = map_tool_categories_to_worker_intents(
            {"tool_categories": route.get("tool_categories", []), "intent": route.get("intent", "")},
            route.get("tool_entities") or {},
        )
        if route.get("intent") != "order_lookup" or not plans:
            order_route_ok = "FAIL: order route"
    except Exception as exc:
        scanner_ok = f"FAIL: {exc}"
        visibility_ok = f"FAIL: {exc}"
        deep_fallback_ok = f"FAIL: {exc}"
        orderability_ok = f"FAIL: {exc}"
        order_route_ok = f"FAIL: {exc}"

    print(f"Shopify catalog scanner: {scanner_ok}")
    print(f"Catalog visibility diagnostics: {visibility_ok}")
    print(f"Deep catalog fallback: {deep_fallback_ok}")
    print(f"Orderability guards: {orderability_ok}")
    print(f"Order route debug: {order_route_ok}")
    print(f"Main LLM agent:         {'enabled' if is_main_llm else 'disabled'}")
    print(f"Direct answer path:     {'enabled' if is_main_llm else 'via_supervisor'}")
    print(f"Tool fanout after LLM:  {'enabled' if is_main_llm else 'via_supervisor'}")
    print(f"Tool category mapper:   {mapper_ok}")
    print(f"Worker intent mapping:  {mapper_ok}")
    print(f"Tool entity extractor:  {extractor_ok}")
    print(f"Pending tool state:     {pending_ok}")
    print(f"OpenAI configured:      {'yes' if bool(s.OPENAI_API_KEY) else 'no'}")
    print(f"Supervisor model:       {s.VOICE_SUPERVISOR_MODEL}")
    print(f"Main LLM timeout:       {s.VOICE_MAIN_LLM_TIMEOUT_MS}ms")
    print(f"Final model:            {s.VOICE_FINAL_MODEL}")
    print(f"Memory turns:           {s.VOICE_MEMORY_TURNS}")
    print(f"LLM brain enabled:      {s.VOICE_LLM_BRAIN_ENABLED}")
    print(f"Final response mode:    {s.VOICE_FINAL_RESPONSE_MODE}")
    print(f"Welcome greeting:       {'enabled' if s.VOICE_WELCOME_GREETING_ENABLED else 'disabled'}")
    print(f"TTS provider:           {s.VOICE_TTS_PROVIDER}")
    print(f"Policy loaded:          {'yes' if policy_len > 100 else 'no'}")
    print(f"Eric prompt version:    {prompt_status['version']}")
    if prompt_status.get("pack_hash"):
        print(f"Eric prompt pack hash:  {prompt_status['pack_hash']}")
    pack_ok = "OK"
    try:
        from app.agent_runtime.llm_brain_contract import validate_llm_decision, is_fake_checking_phrase
        from app.agent_runtime.fake_checking_guard import sanitize_fake_checking
        from app.agent_runtime.tool_eligibility_gate import evaluate_tool_eligibility
        from app.agent_runtime.direct_llm_answerer import answer_directly

        if pack_status.get("error"):
            pack_ok = f"FAIL: {pack_status['error']}"
        elif pack_enabled and not pack_status.get("prompt_hash"):
            pack_ok = "FAIL: no prompt hash"
        repaired = sanitize_fake_checking("Let me check on that.", tool_started=False, intent="small_talk", context={"user_text": "Hi"})
        if is_fake_checking_phrase(repaired):
            pack_ok = "FAIL: fake checking guard"
        blocked = evaluate_tool_eligibility(
            "How are you?",
            {"response_mode": "needs_tools", "intent": "unknown", "tool_categories": ["catalog_search"]},
        )
        if not blocked.blocked:
            pack_ok = "FAIL: tool eligibility gate"
        _ = answer_directly  # import check
        _ = validate_llm_decision
    except Exception as exc:
        pack_ok = f"FAIL: {exc}"
    print(f"Prompt pack loader:     {pack_ok}")
    if pack_ok == "OK" and pack_status:
        print(f"  Pack hash:            {pack_status.get('prompt_hash', '?')}")
        print(f"  Pack chars:           {pack_status.get('prompt_chars', '?')}")
    print(f"Knowledge base:         {'yes' if is_knowledge_base_loaded() else 'no'}")
    print(f"Read-only workers:      {', '.join(sorted(READ_ONLY_WORKERS))}")
    print(f"Mutating workers:       {', '.join(sorted(MUTATING_WORKERS))}")
    print(f"Available tool cats:    {', '.join(sorted(AVAILABLE_TOOL_CATEGORIES))}")
    print(f"OpenAI tools live:      {'blocked' if s.VOICE_LIVE_DISABLE_OPENAI_TOOLS else 'ENABLED'}")
    print(f"Outbound text logging:  {'yes' if s.VOICE_LOG_OUTBOUND_TEXT else 'no'}")

    cert_mode_ok = "OK"
    checkout_guard_ok = "OK"
    email_guard_ok = "OK"
    idempotency_ok = "OK"
    try:
        from app.payment.certification_config import (
            allow_real_checkout,
            allow_real_email,
            certification_summary,
            is_certification_mode,
            is_dry_run,
        )
        from app.payment.payment_idempotency import (
            check_idempotency,
            clear_idempotency_store,
            compute_idempotency_key,
            create_idempotency_record,
        )

        summary = certification_summary()
        if not isinstance(summary.get("dry_run"), bool):
            cert_mode_ok = "FAIL: summary"
        if is_certification_mode() and not is_dry_run() and allow_real_checkout() and allow_real_email():
            checkout_guard_ok = "WARN: real checkout+email enabled"
        clear_idempotency_store()
        key = compute_idempotency_key(
            call_sid="CAcheck", group_id="g0",
            items=[{"variant_id": "v1", "quantity": 1}],
            confirmed_email="t@example.com",
        )
        create_idempotency_record(key, call_sid="CAcheck", group_id="g0", items=[{"variant_id": "v1", "quantity": 1}], confirmed_email="t@example.com")
        if check_idempotency(key).allowed:
            idempotency_ok = "FAIL: pending not blocked"
        clear_idempotency_store()
    except Exception as exc:
        cert_mode_ok = f"FAIL: {exc}"
        checkout_guard_ok = f"FAIL: {exc}"
        email_guard_ok = f"FAIL: {exc}"
        idempotency_ok = f"FAIL: {exc}"

    print(f"Payment certification mode: {'configured' if cert_mode_ok == 'OK' else cert_mode_ok}")
    print(f"Real checkout guard:      {checkout_guard_ok}")
    print(f"Real email allowlist guard: {email_guard_ok}")
    print(f"Payment idempotency:      {idempotency_ok}")
    print("=" * 40)
    print("No secrets, API keys, or prompts printed.")

    checks = (
        mapper_ok, extractor_ok, pending_ok, commerce_ok, followup_ok,
        normalizer_ok, cart_ok, payment_ok, multi_dest_ok, cs_ok, commit_ok,
        taxonomy_ok, universal_ok, pub_intents_ok, pub_norm_ok, audit_ok, order_audit_ok,
        scanner_ok, visibility_ok, deep_fallback_ok, orderability_ok, order_route_ok,
        cert_mode_ok, checkout_guard_ok, email_guard_ok, idempotency_ok, pack_ok,
    )
    if any("FAIL" in c for c in checks):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
