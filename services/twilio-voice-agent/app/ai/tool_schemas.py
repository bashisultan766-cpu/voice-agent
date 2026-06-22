"""
OpenAI function/tool schema definitions.

These are passed as the `tools` parameter in every chat completion request.
"""

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "search_products",
            "description": (
                "Search the Shopify catalog for books or products. "
                "Use when the caller asks about titles, authors, genres, ISBNs, or availability. "
                "Accepts spoken or typed ISBNs and tries barcode lookup automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search terms, e.g. book title, author name, ISBN, or genre.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of results (1–10). Defaults to 5.",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_product_details",
            "description": (
                "Fetch full details for a specific product using its Shopify GID "
                "(gid://shopify/Product/...) or URL handle (e.g. 'the-great-gatsby')."
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
            "name": "lookup_order",
            "description": (
                "Look up a Shopify order by order number, email, or phone. "
                "Full details (items, total, tracking) require order_number + email or phone. "
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
    {
        "type": "function",
        "function": {
            "name": "get_refund_status",
            "description": (
                "Check refund status for a specific order. "
                "Requires order_number plus email or phone for identity verification. "
                "Use when the caller asks if their refund has been processed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_number": {
                        "type": "string",
                        "description": "Order number with or without #.",
                    },
                    "email": {
                        "type": "string",
                        "description": "Customer email for verification.",
                    },
                    "phone": {
                        "type": "string",
                        "description": "Customer phone for verification.",
                    },
                },
                "required": ["order_number"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_checkout_link",
            "description": (
                "Create a Shopify draft order and return a payment URL. "
                "Use after the caller confirms items. "
                "Automatically prevents duplicate links within the same call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "Cart items.",
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
                        "description": "Customer email.",
                    },
                    "phone": {
                        "type": "string",
                        "description": "Customer phone number.",
                    },
                    "customer_name": {
                        "type": "string",
                        "description": "Customer name for order note.",
                    },
                },
                "required": ["items"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_payment_link_email",
            "description": (
                "Email the payment link to the caller. "
                "Use after create_checkout_link if the caller wants the link sent to their email. "
                "Prevents duplicate sends within the same call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "email": {
                        "type": "string",
                        "description": "Customer email address to send the payment link to.",
                    },
                },
                "required": ["email"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "escalate_to_human",
            "description": (
                "Transfer the caller to a human agent or flag for callback. "
                "Use when the caller asks for a human, or when you cannot resolve their request."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Brief reason for escalation.",
                    },
                    "caller_phone": {
                        "type": "string",
                        "description": "Caller phone number (auto-populated from session).",
                    },
                    "summary": {
                        "type": "string",
                        "description": "Brief conversation summary for the human agent.",
                    },
                },
                "required": ["reason"],
            },
        },
    },
]
