"""Spoken US dollar amounts for voice customer service."""
from __future__ import annotations

import re

_ONES = (
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
)
_TENS = (
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
)

_MONEY_FIELD_RE = re.compile(
    r"^\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*([A-Za-z]{3})?\s*$"
)


def _speak_under_thousand(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        if ones:
            return f"{_TENS[tens]} {_ONES[ones]}"
        return _TENS[tens]
    hundreds, rem = divmod(n, 100)
    if rem:
        return f"{_ONES[hundreds]} hundred {_speak_under_thousand(rem)}"
    return f"{_ONES[hundreds]} hundred"


def speak_int(n: int) -> str:
    """Speak a non-negative integer in English."""
    n = int(n)
    if n < 0:
        return str(n)
    if n < 1000:
        return _speak_under_thousand(n)
    thousands, rem = divmod(n, 1000)
    if rem:
        return f"{_speak_under_thousand(thousands)} thousand {_speak_under_thousand(rem)}"
    return f"{_speak_under_thousand(thousands)} thousand"


def parse_money_field(value: str) -> tuple[float, str]:
    """Parse values like ``18.52 USD`` or ``$18.52``."""
    raw = (value or "").strip()
    if not raw:
        return 0.0, "USD"
    m = _MONEY_FIELD_RE.match(raw.replace(",", ""))
    if not m:
        digits = re.sub(r"[^\d.]", "", raw)
        try:
            return float(digits or 0), "USD"
        except ValueError:
            return 0.0, "USD"
    amount = float(m.group(1))
    currency = (m.group(2) or "USD").upper()
    return amount, currency


def speak_usd_amount(amount: float) -> str:
    """
    Natural spoken dollars and cents, e.g. 90.99 →
    ``ninety dollars and ninety-nine cents``.
    """
    if amount < 0:
        amount = abs(amount)
    dollars = int(amount)
    cents = int(round((amount - dollars) * 100))
    if cents >= 100:
        dollars += 1
        cents = 0

    dollar_word = "dollar" if dollars == 1 else "dollars"
    if cents == 0:
        return f"{speak_int(dollars)} {dollar_word}"

    cent_word = "cent" if cents == 1 else "cents"
    return f"{speak_int(dollars)} {dollar_word} and {speak_int(cents)} {cent_word}"


def speak_money_field(value: str) -> str:
    """Speak a pricing field from order JSON."""
    amount, currency = parse_money_field(value)
    if currency and currency != "USD":
        return f"{speak_usd_amount(amount)} {currency}"
    return speak_usd_amount(amount)
