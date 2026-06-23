#!/usr/bin/env python3
"""Commerce tool inventory report (v4.14.9). Inspects workers — no secrets printed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Registry: section -> list of tool descriptors
_COMMERCE_INVENTORY: list[dict] = [
    # 1. Product/catalog
    {"section": "Product/catalog workers", "worker": "universal_catalog_search", "file": "app/workers/universal_catalog_search_worker.py",
     "categories": ["catalog_search"], "intents": ["catalog_product_search", "newspaper_search", "magazine_search", "subscription_search", "publication_search"],
     "entities": ["product_phrase", "title", "product_kind", "subscription_term"], "read_only": True, "main_llm": True},
    {"section": "Product/catalog workers", "worker": "product_search", "file": "app/workers/product_search_worker.py",
     "categories": ["catalog_search"], "intents": ["product_search", "book_title_search", "author_search", "price_question"],
     "entities": ["title", "author", "product_phrase"], "read_only": True, "main_llm": True},
    {"section": "Product/catalog workers", "worker": "product_isbn", "file": "app/workers/product_isbn_worker.py",
     "categories": ["isbn_lookup", "catalog_search"], "intents": ["isbn_search"],
     "entities": ["isbn"], "read_only": True, "main_llm": True},
    {"section": "Product/catalog workers", "worker": "book_title_extractor", "file": "app/workers/book_title_extractor_worker.py",
     "categories": ["catalog_search"], "intents": ["book_title_search"],
     "entities": ["title"], "read_only": True, "main_llm": True},
    {"section": "Product/catalog workers", "worker": "availability_backorder", "file": "app/workers/availability_backorder_worker.py",
     "categories": ["catalog_search"], "intents": ["confirm_product", "price_question"],
     "entities": ["variant_id"], "read_only": True, "main_llm": True},
    {"section": "Product/catalog workers", "worker": "price_inventory", "file": "app/workers/price_inventory_worker.py",
     "categories": ["catalog_search"], "intents": ["price_question"],
     "entities": ["variant_id", "product_id"], "read_only": True, "main_llm": True},
    # 2. ISBN
    {"section": "ISBN workers", "worker": "isbn_fragment", "file": "app/workers/isbn_fragment_worker.py",
     "categories": ["isbn_lookup"], "intents": ["isbn_search"],
     "entities": ["isbn"], "read_only": True, "main_llm": True},
    # 3. Newspaper/magazine
    {"section": "Newspaper/magazine/subscription workers", "worker": "universal_catalog_search", "file": "app/workers/universal_catalog_search_worker.py",
     "categories": ["catalog_search"], "intents": ["newspaper_search", "magazine_search"],
     "entities": ["publication_title", "delivery_frequency", "subscription_term"], "read_only": True, "main_llm": True},
    # 4. Order
    {"section": "Order lookup workers", "worker": "order_lookup", "file": "app/workers/order_lookup_worker.py",
     "categories": ["order_lookup"], "intents": ["order_lookup"],
     "entities": ["order_number", "email", "phone"], "read_only": True, "main_llm": True},
    {"section": "Order lookup workers", "worker": "caller_identity", "file": "app/workers/caller_identity_worker.py",
     "categories": ["order_lookup", "refund_lookup"], "intents": ["order_lookup", "refund_status"],
     "entities": ["phone", "email"], "read_only": True, "main_llm": True},
    {"section": "Order lookup workers", "worker": "tracking", "file": "app/workers/tracking_worker.py",
     "categories": ["order_lookup"], "intents": ["order_lookup"],
     "entities": ["order_number"], "read_only": True, "main_llm": True},
    # 5. Refund
    {"section": "Refund workers", "worker": "refund", "file": "app/workers/refund_worker.py",
     "categories": ["refund_lookup"], "intents": ["refund_status", "refund_detail"],
     "entities": ["order_number", "email"], "read_only": True, "main_llm": True},
    # 6. Facility
    {"section": "Facility workers", "worker": "facility_approval", "file": "app/workers/facility_approval_worker.py",
     "categories": ["facility_approval"], "intents": ["facility_approval"],
     "entities": ["facility_name"], "read_only": True, "main_llm": True},
    {"section": "Facility workers", "worker": "facility_restriction", "file": "app/workers/facility_restriction_worker.py",
     "categories": ["facility_restriction"], "intents": ["facility_restriction"],
     "entities": ["facility_name", "product_kind"], "read_only": True, "main_llm": True},
    # 7. Cart
    {"section": "Cart workers", "worker": "cart_mutation", "file": "app/workers/cart_mutation_worker.py",
     "categories": ["cart_mutation"], "intents": ["add_to_cart", "remove_from_cart", "multi_book_order"],
     "entities": ["variant_id", "quantity"], "read_only": False, "main_llm": True},
    {"section": "Cart workers", "worker": "cart_memory", "file": "app/workers/cart_memory_worker.py",
     "categories": ["cart_memory"], "intents": ["cart_count_question", "memory_summary_question"],
     "entities": [], "read_only": True, "main_llm": True},
    # 8. Payment
    {"section": "Payment/checkout/email workers", "worker": "payment_flow", "file": "app/workers/payment_flow_worker.py",
     "categories": ["payment_flow"], "intents": ["send_payment_link", "payment_execute"],
     "entities": ["email"], "read_only": False, "main_llm": True},
    {"section": "Payment/checkout/email workers", "worker": "checkout", "file": "app/workers/checkout_worker.py",
     "categories": ["payment_flow"], "intents": ["send_payment_link"],
     "entities": ["variant_id", "email"], "read_only": False, "main_llm": False},
    {"section": "Payment/checkout/email workers", "worker": "payment_email", "file": "app/workers/payment_email_worker.py",
     "categories": ["payment_flow"], "intents": ["send_payment_link"],
     "entities": ["email"], "read_only": False, "main_llm": False},
    {"section": "Payment/checkout/email workers", "worker": "email_fragment", "file": "app/workers/email_fragment_worker.py",
     "categories": ["email_capture"], "intents": ["email_provided", "email_confirmation"],
     "entities": ["email"], "read_only": False, "main_llm": True},
    {"section": "Payment/checkout/email workers", "worker": "spell_email", "file": "app/workers/spell_email_worker.py",
     "categories": ["email_capture"], "intents": ["spell_email_request"],
     "entities": [], "read_only": True, "main_llm": True},
    # 9. Escalation
    {"section": "Escalation/address workers", "worker": "address_update", "file": "app/workers/address_update_worker.py",
     "categories": ["address_update", "escalation"], "intents": ["address_update"],
     "entities": ["address_update"], "read_only": False, "main_llm": True},
    {"section": "Escalation/address workers", "worker": "escalation", "file": "app/workers/escalation_worker.py",
     "categories": ["escalation"], "intents": ["escalation", "human_escalation"],
     "entities": [], "read_only": False, "main_llm": True},
    # 10. Safety
    {"section": "Safety guards", "worker": "payment_safety", "file": "app/workers/payment_safety_worker.py",
     "categories": ["payment_flow"], "intents": ["send_payment_link"],
     "entities": [], "read_only": True, "main_llm": False},
    {"section": "Safety guards", "worker": "PaymentSafetyGuard", "file": "app/payment/safety.py",
     "categories": ["payment_flow"], "intents": ["send_payment_link"],
     "entities": ["confirmed_email", "variant_id"], "read_only": True, "main_llm": True},
]

_TEST_PATTERNS = {
    "universal_catalog_search": "test_v4147_universal_shopify_search",
    "product_isbn": "test_v4147_universal_shopify_search",
    "order_lookup": "test_v4147_order_refund_facility_audit",
    "refund": "test_v4147_order_refund_facility_audit",
    "facility_approval": "test_v4147_order_refund_facility_audit",
    "cart_mutation": "test_v4145_cart_orchestrator",
    "payment_flow": "test_v4145_payment_link_orchestrator",
    "PaymentSafetyGuard": "test_v411_payment_safety",
    "email_fragment": "test_v41_email_capture",
}


def _worker_file_exists(rel_path: str) -> bool:
    return (ROOT / rel_path).is_file()


def _has_test(worker: str) -> bool:
    pattern = _TEST_PATTERNS.get(worker, "")
    if not pattern:
        return False
    tests_dir = ROOT / "app" / "tests"
    return any(pattern in f.name for f in tests_dir.glob("*.py"))


def _status(entry: dict) -> str:
    if not _worker_file_exists(entry["file"]):
        return "MISSING"
    if not entry.get("main_llm") and entry["worker"] not in ("checkout", "payment_email", "payment_safety"):
        return "PARTIAL"
    return "OK"


def _print_entry(entry: dict) -> None:
    label = entry["section"].split()[0].capitalize() + " search" if "search" in entry.get("intents", [""])[0] else entry["worker"]
    if entry["section"] == "ISBN workers":
        label = "ISBN lookup"
    elif entry["worker"] == "cart_mutation":
        label = "Cart mutation"
    elif entry["worker"] == "payment_flow":
        label = "Payment flow"
    print(f"{entry['section']}:")
    print(f"  worker={entry['worker']}")
    print(f"  file={entry['file']}")
    print(f"  categories={entry['categories']}")
    print(f"  intents={entry['intents']}")
    print(f"  entities={entry['entities']}")
    print(f"  read_only={entry['read_only']}")
    print(f"  main_llm_runtime={entry['main_llm']}")
    print(f"  tested={_has_test(entry['worker'])}")
    print(f"  status={_status(entry)}")
    print()


def main() -> int:
    from app.workers.orchestrator import _INTENT_WORKERS

    print("=== Commerce Tool Inventory Report (v4.14.9) ===\n")
    seen: set[str] = set()
    sections_order = [
        "Product/catalog workers",
        "ISBN workers",
        "Newspaper/magazine/subscription workers",
        "Order lookup workers",
        "Refund workers",
        "Facility workers",
        "Cart workers",
        "Payment/checkout/email workers",
        "Escalation/address workers",
        "Safety guards",
    ]
    for section in sections_order:
        print(f"--- {section} ---")
        for entry in _COMMERCE_INVENTORY:
            if entry["section"] != section:
                continue
            key = f"{entry['worker']}:{entry['file']}"
            if key in seen:
                continue
            seen.add(key)
            _print_entry(entry)
        print()

    print(f"Orchestrator intent mappings: {len(_INTENT_WORKERS)} intents")
    missing_files = [e for e in _COMMERCE_INVENTORY if not _worker_file_exists(e["file"])]
    if missing_files:
        print(f"WARNING: {len(missing_files)} missing worker files")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
