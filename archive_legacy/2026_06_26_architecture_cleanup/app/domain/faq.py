"""SureShot Books FAQ answer map — deterministic, no catalog invention (v4.6)."""
from __future__ import annotations

import re
from typing import Optional

# Keys match normalized question patterns in sureshot_brain.match_faq
FAQ_ANSWERS: dict[str, str] = {
    "company": (
        "You're calling SureShot Books. We help customers order books and reading materials."
    ),
    "store_name": (
        "This is SureShot Books."
    ),
    "what_we_sell": (
        "We sell books, newspapers, novels, and related reading materials "
        "available in our Shopify catalog."
    ),
    "books_for_inmates": (
        "Yes. A common use is helping families send approved reading materials "
        "to inmates and correctional facilities when the items are available in our catalog."
    ),
    "send_to_facility": (
        "Yes, when the book is available and allowed for that facility. "
        "I can help you find titles and send a payment link."
    ),
    "facility_allows_book": (
        "I can help you check a title in our catalog. Facility approval rules vary — "
        "I do not invent facility policies. I can search the book and guide you on next steps."
    ),
    "newspapers": (
        "If newspapers are listed in our Shopify catalog, I can help you find and order them."
    ),
    "novels": (
        "Yes, I can search novels by ISBN, title, or author in our catalog."
    ),
    "payment_link": (
        "Yes. Once we confirm the book and your email, I can send a secure payment link."
    ),
    "multiple_books": (
        "Yes. You can add multiple books to your cart and pay with one payment link."
    ),
    "use_isbn": (
        "Yes. You can give me an ISBN and I will search our catalog."
    ),
    "use_title": (
        "Yes. You can give me a title or author and I will search our catalog."
    ),
    "order_status": (
        "I can help check order status. Please share your order number when you're ready."
    ),
    "track_shipping": (
        "I can help with tracking once I have your order number."
    ),
    "refund_status": (
        "I can help with refund questions. Please share your order number when you're ready."
    ),
    "update_address": (
        "For address changes, I can guide you based on your order status. "
        "Share your order number and I will help."
    ),
    "cancel_order": (
        "I can help with cancellation requests. Share your order number and I will guide you."
    ),
    "book_not_found": (
        "If a book is not in our catalog, I will tell you we could not find a match. "
        "You can try another ISBN or title."
    ),
    "facility_rejects": (
        "If a facility rejects a book, support can help with next steps. "
        "I do not invent refund outcomes — I can look up your order if you have one."
    ),
    "details_by_email": (
        "Yes. After we confirm your email, I can send order or payment details by email."
    ),
    "spell_email": (
        "Yes. I can spell your email back letter by letter."
    ),
    "politics_books": (
        "I can help you look for books on that topic in our catalog."
    ),
    "sports_books": (
        "I can help you look for books on that topic in our catalog."
    ),
    "talk_politics": (
        "I can help you look for books on that topic in our catalog."
    ),
    "recommend_books": (
        "Tell me a subject, author, or ISBN and I will search our catalog for you."
    ),
    "check_price": (
        "Tell me the ISBN or title and I will check price from our catalog."
    ),
    "check_availability": (
        "Tell me the ISBN or title and I will check availability in our catalog."
    ),
    "backorder": (
        "If an item is backordered, I will tell you what our catalog shows. "
        "Give me the ISBN or title to check."
    ),
    "order_for_someone": (
        "Yes. You can order for someone else. Tell me the books and I will help with the order."
    ),
    "send_to_inmate": (
        "Yes. Many customers order reading materials for inmates. "
        "Tell me the ISBN or title and I will search our catalog."
    ),
    "payment_link_info": (
        "I need the confirmed book and a confirmed email address before sending a payment link."
    ),
    "wrong_email": (
        "No problem. Tell me the correct email or spell it slowly and I will update it."
    ),
    "did_send_link": (
        "I will only say the link was sent after it is confirmed on our side. "
        "Ask me and I will check the payment status for this call."
    ),
    "read_cart": (
        "I can read back the books in your cart. Ask how many books or the titles."
    ),
    "cart_count": (
        "Ask how many books you selected and I will read from your cart."
    ),
    "titles_one_by_one": (
        "Ask me to list the titles one by one and I will read from your cart."
    ),
    "remove_book": (
        "Tell me which book to remove and I will update your cart."
    ),
    "include_two_books": (
        "Tell me which two books to include and I will update your cart."
    ),
    "transfer": (
        "I can connect you with customer service. Would you like me to escalate?"
    ),
    "customer_service": (
        "I can connect you with customer service. Would you like me to escalate?"
    ),
}

_PATTERNS: list[tuple[str, str]] = [
    (r"what company is this|what(?:'s| is) your company", "company"),
    (r"what(?:'s| is) (?:your )?store name|store number name", "store_name"),
    (r"what do you sell|what(?:'s| is) your business", "what_we_sell"),
    (r"books? for inmates?|inmate books?", "books_for_inmates"),
    (r"send books? to (?:a )?facility|facility.{0,20}send", "send_to_facility"),
    (r"facility allows?|check if .{0,30}facility allows?", "facility_allows_book"),
    (r"send newspapers?|newspapers?", "newspapers"),
    (r"send novels?|can you send novels?", "novels"),
    (r"send (?:a )?payment link|payment link", "payment_link"),
    (r"order multiple books?|multiple books?", "multiple_books"),
    (r"can i use isbn|use isbn", "use_isbn"),
    (r"can i use (?:the )?title|search by title", "use_title"),
    (r"order status|check (?:my )?order", "order_status"),
    (r"track (?:my )?shipping|track (?:my )?order", "track_shipping"),
    (r"refund status|ask for refund", "refund_status"),
    (r"update (?:my )?address|change (?:my )?address", "update_address"),
    (r"cancel (?:my )?order", "cancel_order"),
    (r"book (?:is )?not found|if .{0,20}not found", "book_not_found"),
    (r"facility rejects?|rejects? (?:the )?book", "facility_rejects"),
    (r"send details by email|details by email", "details_by_email"),
    (r"spell (?:my )?email", "spell_email"),
    (r"books? about politics|buy books? about politics", "politics_books"),
    (r"sports books?|books? about sports", "sports_books"),
    (r"talk about politics|discuss politics", "talk_politics"),
    (r"recommend books?", "recommend_books"),
    (r"check (?:the )?price|what(?:'s| is) the price", "check_price"),
    (r"check availability|in stock|available", "check_availability"),
    (r"backorder", "backorder"),
    (r"order for someone else|for someone else", "order_for_someone"),
    (r"send to (?:an )?inmate|order for inmate", "send_to_inmate"),
    (r"what .{0,30}need for payment link|information .{0,20}payment link", "payment_link_info"),
    (r"wrong email|gave wrong email", "wrong_email"),
    (r"did you send (?:the )?payment link|did you send (?:the )?link", "did_send_link"),
    (r"read (?:my )?cart|what(?:'s| is) in my cart", "read_cart"),
    (r"how many books? did i select|how many books? (?:did )?i", "cart_count"),
    (r"titles? one by one|tell (?:me )?the titles?", "titles_one_by_one"),
    (r"remove (?:a )?book|take (?:a )?book out", "remove_book"),
    (r"include only two books?|only two books?", "include_two_books"),
    (r"transfer me|speak to (?:a )?human", "transfer"),
    (r"customer service|speak to customer service", "customer_service"),
]


def match_faq(text: str) -> Optional[str]:
    """Return FAQ answer if text matches a known domain question."""
    t = text.strip()
    if not t:
        return None
    for pattern, key in _PATTERNS:
        if re.search(pattern, t, re.IGNORECASE):
            return FAQ_ANSWERS.get(key)
    return None
