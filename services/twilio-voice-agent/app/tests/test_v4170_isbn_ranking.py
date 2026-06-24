"""Regression tests for ISBN validation + deterministic candidate ranking (v4.17)."""
import pytest

from app.tools.isbn import (
    extract_isbn_candidate,
    is_strict_valid_isbn,
    isbn10_checksum_valid,
    isbn13_checksum_valid,
    looks_like_isbn_fragment,
)
from app.agent_runtime.isbn_candidate_ranker import (
    RankedCandidate,
    classify_match_type,
    rank_candidates,
    select_best_product,
    select_top_candidate,
)

# The live ISBN from the defect logs and its correct product.
GOOD_ISBN = "9780997361308"
GOOD_TITLE = "100,000 and Freedom Too..."
WRONG_TITLE = "From Dead to Worse"
SPOKEN_GOOD_ISBN = "9 7 8 0 9 9 7 3 6 1 3 0 8"


class TestStrictValidation:
    def test_valid_isbn13_checksum(self):
        assert isbn13_checksum_valid(GOOD_ISBN)
        assert is_strict_valid_isbn(GOOD_ISBN)

    def test_wrong_isbn13_checksum_rejected(self):
        assert not isbn13_checksum_valid("9780997361309")
        assert not is_strict_valid_isbn("9780997361309")

    def test_isbn10_checksum(self):
        # 0306406152 is a valid ISBN-10.
        assert isbn10_checksum_valid("0306406152")
        # 014312755X has an invalid checksum and must be rejected by strict path.
        assert not isbn10_checksum_valid("014312755X")

    def test_fragment_is_not_valid(self):
        assert not is_strict_valid_isbn("9780")
        assert extract_isbn_candidate("9780") is None
        assert looks_like_isbn_fragment("9780")

    def test_extract_spoken_digits(self):
        assert extract_isbn_candidate(SPOKEN_GOOD_ISBN) == GOOD_ISBN

    def test_extract_isbn10_upconverts(self):
        # Valid ISBN-10 should up-convert to a valid ISBN-13.
        out = extract_isbn_candidate("0306406152")
        assert out is not None and len(out) == 13
        assert isbn13_checksum_valid(out)


class TestIsbnSpokenDigitsExactMatch:
    def test_isbn_spoken_digits_exact_match(self):
        """Spoken ISBN 9780997361308 selects the correct exact product."""
        candidates = [
            {"title": GOOD_TITLE, "isbn": GOOD_ISBN, "barcode": GOOD_ISBN},
            {"title": WRONG_TITLE, "title_match": True},
        ]
        top = select_best_product(
            candidates,
            requested_isbn=extract_isbn_candidate(SPOKEN_GOOD_ISBN),
        )
        assert top is not None
        assert top.title == GOOD_TITLE
        assert top.match_type == "exact_valid_isbn"


class TestIsbnPartialFragmentNeverWins:
    def test_isbn_partial_fragment_never_wins(self):
        """A '9780' fragment candidate must never outrank an exact ISBN match."""
        exact = RankedCandidate(
            title=GOOD_TITLE,
            match_type=classify_match_type(
                {"title": GOOD_TITLE, "isbn": GOOD_ISBN, "barcode": GOOD_ISBN},
                requested_isbn=GOOD_ISBN,
            ),
            isbn=GOOD_ISBN,
        )
        fragment = RankedCandidate(
            title=WRONG_TITLE,
            match_type=classify_match_type(
                {"title": WRONG_TITLE},
                requested_isbn=None,
                origin_query="9780",
            ),
            origin_query="9780",
        )
        assert exact.match_type == "exact_valid_isbn"
        assert fragment.match_type == "fragment"

        top = select_top_candidate([fragment, exact])
        assert top is not None
        assert top.title == GOOD_TITLE
        assert top.title != WRONG_TITLE

    def test_fragment_only_still_returns_but_marked(self):
        fragment = RankedCandidate(
            title=WRONG_TITLE,
            match_type=classify_match_type(
                {"title": WRONG_TITLE}, origin_query="9780"
            ),
            origin_query="9780",
        )
        top = select_top_candidate([fragment])
        assert top is not None
        assert top.match_type == "fragment"

    def test_ranking_order_is_deterministic(self):
        cands = [
            RankedCandidate(title="f", match_type="fragment"),
            RankedCandidate(title="ft", match_type="fuzzy_title"),
            RankedCandidate(title="isbn", match_type="exact_valid_isbn"),
            RankedCandidate(title="bc", match_type="exact_barcode"),
            RankedCandidate(title="sku", match_type="exact_sku"),
            RankedCandidate(title="et", match_type="exact_title"),
        ]
        ordered = [c.title for c in rank_candidates(cands)]
        assert ordered == ["isbn", "bc", "sku", "et", "ft", "f"]
