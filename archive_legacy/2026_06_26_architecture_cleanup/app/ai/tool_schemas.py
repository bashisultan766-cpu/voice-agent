"""
OpenAI function/tool schema definitions — ElevenLabs-aligned names (v4.2).

Tool names here match the system prompt exactly. The registry maps each name
to its implementation in app/tools/shopify_tools.py.
"""

TOOL_SCHEMAS: list[dict] = [
    # ── 1. GetOrder ─────────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "GetOrder",
            "description": (
                "Look up a Shopify order by order number, email, or phone. "
                "Returns order status, fulfillment status, items, subtotal, shipping, "
                "tracking, and refund details. "
                "Full financial details require order_number + email or phone. "
                "Order number alone returns status only."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_number": {
                        "type": "string",
                        "description": "Order number with or without #, e.g. '1234' or '#1234'.",
                    },
                    "email": {
                        "type": "string",
                        "description": "Customer email for identity verification.",
                    },
                    "phone": {
                        "type": "string",
                        "description": "Customer phone in E.164 format for verification.",
                    },
                },
                "required": [],
            },
        },
    },
    # ── 2. SureShotCatalogSearch ────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "SureShotCatalogSearch",
            "description": (
                "Search the SureShot Books catalog for books or products. "
                "Use when the caller asks about titles, authors, genres, ISBNs, "
                "availability, stock, price, backorder, or out-of-stock status. "
                "Accepts spoken or typed ISBNs and tries barcode lookup automatically. "
                "This is the authoritative source for availability — never guess."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search terms: book title, author name, ISBN, SKU, or keyword.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (1–10). Defaults to 5.",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        },
    },
    # ── 3. CalculatePricing ─────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "CalculatePricing",
            "description": (
                "Retrieve pricing and shipping details for an order. "
                "Use when the caller asks about subtotal, shipping cost, total price, "
                "Media Mail, Priority Mail, shipping method, or estimated final total. "
                "Returns subtotal (before shipping), shipping amount, and shipping method."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_number": {
                        "type": "string",
                        "description": "Order number to retrieve pricing for.",
                    },
                    "email": {
                        "type": "string",
                        "description": "Customer email for verification (required for full details).",
                    },
                    "phone": {
                        "type": "string",
                        "description": "Customer phone for verification.",
                    },
                },
                "required": [],
            },
        },
    },
    # ── 4. CheckFacilityApproval ────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "CheckFacilityApproval",
            "description": (
                "Check whether SureShot Books is approved to ship to a correctional "
                "facility, prison, jail, or institution. "
                "Use when the caller asks 'Are you approved to ship there?' "
                "Never guess — only report what the backend confirms."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "facility_name": {
                        "type": "string",
                        "description": "Name of the facility (include city/state if known).",
                    },
                    "order_number": {
                        "type": "string",
                        "description": "Optional order number to cross-reference facility data.",
                    },
                },
                "required": ["facility_name"],
            },
        },
    },
    # ── 5. CheckOrderFacilityRestrictions ───────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "CheckOrderFacilityRestrictions",
            "description": (
                "Check book restrictions for a correctional facility on a specific order. "
                "Use when the caller asks whether books in an order are accepted by a facility, "
                "or whether one book may be rejected. "
                "Returns known restrictions (hardcover ban, new-only, publisher list, etc.)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_number": {
                        "type": "string",
                        "description": "Order number to check facility restrictions against.",
                    },
                    "facility_name": {
                        "type": "string",
                        "description": "Facility name for context (if order number not available).",
                    },
                },
                "required": [],
            },
        },
    },
    # ── 6. AddressUpdateInstructions ────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "AddressUpdateInstructions",
            "description": (
                "Provide instructions for updating a shipping address on an order. "
                "Use when the caller wants to change, correct, or update the delivery address. "
                "Returns the correct email contact and what information to include."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_number": {
                        "type": "string",
                        "description": "Order number the address update applies to.",
                    },
                },
                "required": [],
            },
        },
    },
    # ── 7. CancelOrderRequest ───────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "CancelOrderRequest",
            "description": (
                "Check cancellation eligibility for an order and initiate the request. "
                "Use when the caller asks to cancel an order. "
                "Returns whether the order can be cancelled (not yet shipped) or must go "
                "to customer service (already shipped or fulfilled)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_number": {
                        "type": "string",
                        "description": "Order number to cancel.",
                    },
                    "email": {
                        "type": "string",
                        "description": "Customer email for verification.",
                    },
                },
                "required": ["order_number"],
            },
        },
    },
    # ── 8. EscalateToCustomerService ────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "EscalateToCustomerService",
            "description": (
                "Escalate the call to a human customer service agent or flag for callback. "
                "Use when the caller asks for a human, when you cannot resolve the request, "
                "when a book is not listed, when facility approval is unknown, "
                "when cancellation needs staff approval, or when the customer is upset."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Brief reason for escalation.",
                    },
                    "summary": {
                        "type": "string",
                        "description": "Short conversation summary for the human agent.",
                    },
                },
                "required": ["reason"],
            },
        },
    },
    # ── 9. SendFacilityPaymentLink ──────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "SendFacilityPaymentLink",
            "description": (
                "Send a secure facility/inmate payment link to the customer's email. "
                "Use when the customer needs to complete facility details, inmate details, "
                "or payment information via a secure form. "
                "Only call after confirming the customer's email address."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "email": {
                        "type": "string",
                        "description": "Confirmed customer email to send the secure link to.",
                    },
                    "order_number": {
                        "type": "string",
                        "description": "Optional order number for context.",
                    },
                },
                "required": ["email"],
            },
        },
    },
    # ── 10. SendPaymentLink ─────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "SendPaymentLink",
            "description": (
                "Create a Shopify payment link for the confirmed cart and email it to the customer. "
                "Use when the customer is buying books and wants a payment link sent by email. "
                "Only call AFTER: (1) confirming each book and quantity, "
                "(2) collecting the customer's email, and (3) the customer has confirmed the email. "
                "Never call before email confirmation. Never say the link was sent unless success."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "Confirmed cart items.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "variant_id": {
                                    "type": "string",
                                    "description": "Shopify variant GID.",
                                },
                                "quantity": {
                                    "type": "integer",
                                    "default": 1,
                                },
                            },
                            "required": ["variant_id"],
                        },
                    },
                    "email": {
                        "type": "string",
                        "description": "Customer email — must be confirmed before calling.",
                    },
                    "customer_name": {
                        "type": "string",
                        "description": "Customer name for the order note.",
                    },
                },
                "required": ["items", "email"],
            },
        },
    },
    # ── 11. GetCallerInfo ───────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "GetCallerInfo",
            "description": (
                "Retrieve caller identity and account context from the session. "
                "Use when returning caller recognition is needed or when the customer's "
                "name/account information is not yet loaded."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    # ── 12. SaveCallerName ──────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "SaveCallerName",
            "description": (
                "Save the caller's name to their session so it can be used for personalisation. "
                "Use when the caller provides their name and they were not already recognized."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The caller's name as they stated it.",
                    },
                },
                "required": ["name"],
            },
        },
    },
    # ── Legacy aliases (SureShotCatalogSearch preferred for availability) ────────
    {
        "type": "function",
        "function": {
            "name": "SureShotBooksSku",
            "description": (
                "Legacy: look up a book by SKU or ISBN. "
                "Prefer SureShotCatalogSearch for availability questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "SKU, ISBN, or product identifier."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "SureShotBooksProductFetcher",
            "description": (
                "Legacy: fetch full product details by Shopify GID or URL handle. "
                "Prefer SureShotCatalogSearch for general availability questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "product_id_or_handle": {
                        "type": "string",
                        "description": "Shopify product GID or URL handle.",
                    },
                },
                "required": ["product_id_or_handle"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "SureShotBooksProduct",
            "description": (
                "Legacy: search catalog by keyword, title, or author. "
                "Prefer SureShotCatalogSearch for availability questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword, title, or author."},
                    "limit": {"type": "integer", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
]
