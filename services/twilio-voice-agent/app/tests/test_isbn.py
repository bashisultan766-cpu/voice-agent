"""Tests for ISBN normalization utilities."""
import pytest

from app.tools.isbn import normalize_isbn, isbn10_to_isbn13, is_isbn, _isbn13_check


class TestNormalizeIsbn:
    def test_typed_isbn13_with_hyphens(self):
        assert normalize_isbn("978-0-14-312755-0") == "9780143127550"

    def test_typed_isbn13_clean(self):
        assert normalize_isbn("9780143127550") == "9780143127550"

    def test_typed_isbn13_with_spaces(self):
        assert normalize_isbn("978 0 14 312755 0") == "9780143127550"

    def test_isbn_keyword_prefix_stripped(self):
        assert normalize_isbn("ISBN: 9780143127550") == "9780143127550"
        assert normalize_isbn("isbn 978-0-14-312755-0") == "9780143127550"

    def test_spoken_isbn13(self):
        result = normalize_isbn(
            "nine seven eight zero one four three one two seven five five zero"
        )
        assert result == "9780143127550"

    def test_spoken_with_oh_for_zero(self):
        result = normalize_isbn(
            "nine seven eight oh one four three one two seven five five oh"
        )
        assert result == "9780143127550"

    def test_isbn10_valid(self):
        result = normalize_isbn("0-14-312755-X")
        # Cleaned to 10 chars
        assert result == "014312755X"

    def test_isbn10_spoken(self):
        result = normalize_isbn("zero one four three one two seven five five x")
        assert result is not None
        assert len(result) == 10

    def test_invalid_isbn_returns_none(self):
        assert normalize_isbn("hello world") is None
        assert normalize_isbn("12345") is None
        assert normalize_isbn("") is None

    def test_wrong_check_digit_returns_none(self):
        # Valid ISBN-13 structure but wrong check digit
        assert normalize_isbn("9780143127551") is None

    def test_nonauthor_text_returns_none(self):
        assert normalize_isbn("please find me a book about cats") is None

    def test_spoken_mishearing_variants(self):
        # "to" → 2, "tree" → 3, "niner" → 9
        result = normalize_isbn("nine seven eight oh one four tree one to seven five five oh")
        # May not be valid ISBN but should return a digit string or None (not crash)
        assert result is None or isinstance(result, str)


class TestIsbn10ToIsbn13:
    def test_valid_isbn10(self):
        result = isbn10_to_isbn13("014312755X")
        assert result == "9780143127550"

    def test_isbn10_numeric_check(self):
        # ISBN-10 with numeric check digit
        result = isbn10_to_isbn13("0306406152")
        assert result is not None
        assert len(result) == 13
        assert _isbn13_check(result)

    def test_invalid_length_returns_none(self):
        assert isbn10_to_isbn13("12345") is None
        assert isbn10_to_isbn13("") is None

    def test_handles_hyphens_in_input(self):
        # Function expects clean input, but gracefully handles stripped hyphens
        result = isbn10_to_isbn13("0-14-312755-X".replace("-", ""))
        assert result == "9780143127550"


class TestIsIsbn:
    def test_isbn13_digits(self):
        assert is_isbn("9780143127550") is True

    def test_isbn10_digits(self):
        assert is_isbn("014312755X") is True

    def test_short_number_false(self):
        assert is_isbn("12345") is False

    def test_plain_text_false(self):
        assert is_isbn("hello world") is False

    def test_fourteen_digits_false(self):
        assert is_isbn("97801431275501") is False
