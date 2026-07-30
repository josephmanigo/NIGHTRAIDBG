from __future__ import annotations

import unittest

from modules.scoreboard.ocr_processor import (
    OcrAttempt,
    choose_consensus,
    normalize_integer_candidate,
    normalize_slot_candidate,
)


class OcrNormalizationTests(unittest.TestCase):
    def test_slot_zero_is_corrected_to_o(self) -> None:
        candidate = normalize_slot_candidate("0")
        self.assertEqual(candidate.value, "O")
        self.assertIn("slot_0_to_O", candidate.corrections)

    def test_slots_are_limited_to_a_through_y(self) -> None:
        self.assertEqual(normalize_slot_candidate("m").value, "M")
        self.assertIsNone(normalize_slot_candidate("Z").value)
        self.assertIsNone(normalize_slot_candidate("AB").value)

    def test_player_slot_suffix_is_removed(self) -> None:
        candidate = normalize_slot_candidate("O1")
        self.assertEqual(candidate.value, "O")
        self.assertIn("player_slot_suffix_removed", candidate.corrections)

    def test_g5_is_corrected_to_65_with_evidence(self) -> None:
        candidate = normalize_integer_candidate("G5", minimum=0, maximum=999)
        self.assertEqual(candidate.value, 65)
        self.assertEqual(candidate.corrections, ("numeric_confusable:G5->65",))
        self.assertGreater(candidate.confidence_penalty, 0)

    def test_letter_only_number_is_not_invented(self) -> None:
        self.assertIsNone(
            normalize_integer_candidate("G", minimum=0, maximum=999).value
        )

    def test_fixed_pixel_font_confusables_are_cleaned(self) -> None:
        self.assertEqual(
            normalize_integer_candidate("Zl", minimum=0, maximum=999).value,
            21,
        )
        self.assertEqual(
            normalize_integer_candidate("ee", minimum=0, maximum=999).value,
            22,
        )
        self.assertEqual(
            normalize_integer_candidate("b", minimum=0, maximum=999).value,
            6,
        )

    def test_consensus_uses_multiple_preprocessing_variants(self) -> None:
        result = choose_consensus(
            [
                OcrAttempt("G5", 0.91, "sharpened"),
                OcrAttempt("65", 0.94, "otsu"),
                OcrAttempt("65", 0.90, "adaptive"),
                OcrAttempt("", 0.0, "inverted"),
            ],
            "kills",
            minimum_confidence=0.82,
            max_placement=25,
            max_kills=999,
        )
        self.assertEqual(result.value, 65)
        self.assertFalse(result.review_required)
        self.assertGreaterEqual(result.confidence, 0.9)

    def test_clean_reading_outweighs_corrected_competitor(self) -> None:
        result = choose_consensus(
            [
                OcrAttempt("37", 0.86, "gray_160"),
                OcrAttempt("3/", 0.82, "gray_200"),
                OcrAttempt("7|", 0.94, "otsu"),
            ],
            "kills",
            minimum_confidence=0.82,
            max_placement=25,
            max_kills=999,
        )
        self.assertEqual(result.value, 37)
        self.assertFalse(result.review_required)

    def test_tied_conflict_requires_review(self) -> None:
        result = choose_consensus(
            [
                OcrAttempt("31", 0.97, "otsu"),
                OcrAttempt("37", 0.97, "adaptive"),
            ],
            "kills",
            minimum_confidence=0.82,
            max_placement=25,
            max_kills=999,
        )
        self.assertTrue(result.review_required)
        self.assertLessEqual(result.confidence, 0.6)

    def test_unreadable_value_is_null(self) -> None:
        result = choose_consensus(
            [OcrAttempt("???", 0.99, "otsu")],
            "placement",
            minimum_confidence=0.82,
            max_placement=25,
            max_kills=999,
        )
        self.assertIsNone(result.value)
        self.assertTrue(result.review_required)


if __name__ == "__main__":
    unittest.main()
