from __future__ import annotations

import json
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest.mock import patch

import numpy as np

from modules.scoreboard.contracts import FieldReading
from modules.scoreboard.image_processor import (
    FieldCrop,
    LoadedImage,
    require_opencv,
)
from modules.scoreboard.ocr_processor import (
    LocalScoreboardReader,
    OcrAttempt,
    PytesseractEngine,
    _classify_d_f_p_glyph,
    _classify_h_r_glyph,
    _reconcile_eight_nine,
    _reconcile_fixed_eighteen,
    _reconcile_missing_leading_one,
    _reconcile_repeated_one,
    _reconcile_slot_marker,
    _reconcile_supported_numeric,
    _reconcile_terminal_six,
    _reconcile_three_misread_as_four,
    _reconcile_uncontested_three,
    _reconcile_unreadable_seventeen,
    _reconcile_zero_kill,
)
from modules.scoreboard.team_manager import TeamRegistry


def pipeline_layout() -> dict[str, object]:
    return {
        "id": "pipeline-test",
        "version": 1,
        "coordinate_space": 1000,
        "reference_size": {"width": 300, "height": 300},
        "aspect_ratio_tolerance": 0.01,
        "leaderboard_region": [0, 0, 1000, 1000],
        "rows": [
            [0, 0, 1000, 333],
            [0, 333, 1000, 334],
            [0, 667, 1000, 333],
        ],
        "columns": {
            "placement": [0, 0, 333, 1000],
            "slot": [333, 0, 334, 1000],
            "kills": [667, 0, 333, 1000],
        },
        "ocr": {
            "upscale": 2,
            "minimum_confidence": 0.82,
            "sequence_anchor_confidence": 0.7,
            "max_placement": 25,
            "max_kills": 999,
        },
    }


class FakeEngine:
    def __init__(self) -> None:
        self.values = {
            "placement": ["", "2", "3"],
            "slot": ["0", "M", "R"],
            "kills": ["G5", "7", "31"],
        }
        self.calls: dict[str, int] = defaultdict(int)

    def recognize(self, _image: np.ndarray, field: str, variant: str) -> OcrAttempt:
        index = self.calls[field]
        self.calls[field] += 1
        return OcrAttempt(self.values[field][index], 0.97, variant)


class FakeBatchEngine:
    def __init__(self) -> None:
        self.values = {
            "placement": ["1", "2", "3"],
            "slot": ["0", "M", "R"],
            "kills": ["G5", "7", "31"],
        }
        self.calls: list[tuple[str, str, int]] = []
        self.single_calls: list[tuple[str, str]] = []

    def recognize(
        self,
        _image: np.ndarray,
        field: str,
        variant: str,
    ) -> OcrAttempt:
        index = len(self.single_calls)
        attempt = OcrAttempt(self.values[field][index], 0.97, variant)
        self.single_calls.append((field, variant))
        return attempt

    def recognize_many(
        self,
        images: list[np.ndarray],
        field: str,
        variant: str,
    ) -> list[OcrAttempt]:
        self.calls.append((field, variant, len(images)))
        return [
            OcrAttempt(value, 0.97, variant)
            for value in self.values[field]
        ]


class ReaderPipelineTests(unittest.TestCase):
    def test_opencv_disambiguates_fixed_slot_glyph_shapes(self) -> None:
        active_cv2 = require_opencv()
        h_r_bgr = active_cv2.cvtColor(
            np.array([[[40, 225, 190]]], dtype=np.uint8),
            active_cv2.COLOR_HSV2BGR,
        )[0, 0].tolist()
        d_f_p_bgr = active_cv2.cvtColor(
            np.array([[[24, 225, 190]]], dtype=np.uint8),
            active_cv2.COLOR_HSV2BGR,
        )[0, 0].tolist()

        def glyph() -> np.ndarray:
            return np.zeros((50, 36, 3), dtype=np.uint8)

        h_pixels = glyph()
        active_cv2.line(h_pixels, (7, 7), (7, 42), h_r_bgr, 4)
        active_cv2.line(h_pixels, (28, 7), (28, 42), h_r_bgr, 4)
        active_cv2.line(h_pixels, (7, 24), (28, 24), h_r_bgr, 4)
        r_pixels = glyph()
        active_cv2.line(r_pixels, (7, 7), (7, 42), h_r_bgr, 4)
        active_cv2.line(r_pixels, (7, 7), (27, 7), h_r_bgr, 4)
        active_cv2.line(r_pixels, (7, 24), (27, 24), h_r_bgr, 4)
        active_cv2.line(r_pixels, (27, 7), (27, 24), h_r_bgr, 4)
        active_cv2.line(r_pixels, (18, 24), (29, 42), h_r_bgr, 4)

        d_pixels = glyph()
        active_cv2.rectangle(d_pixels, (7, 7), (28, 42), d_f_p_bgr, 4)
        f_pixels = glyph()
        active_cv2.line(f_pixels, (7, 7), (7, 42), d_f_p_bgr, 4)
        active_cv2.line(f_pixels, (7, 7), (28, 7), d_f_p_bgr, 4)
        active_cv2.line(f_pixels, (7, 24), (25, 24), d_f_p_bgr, 4)
        p_pixels = glyph()
        active_cv2.line(p_pixels, (7, 7), (7, 42), d_f_p_bgr, 4)
        active_cv2.line(p_pixels, (7, 7), (28, 7), d_f_p_bgr, 4)
        active_cv2.line(p_pixels, (7, 24), (28, 24), d_f_p_bgr, 4)
        active_cv2.line(p_pixels, (28, 7), (28, 24), d_f_p_bgr, 4)

        def crop(pixels: np.ndarray) -> FieldCrop:
            padded = np.pad(
                pixels,
                ((10, 10), (5, 5), (0, 0)),
                constant_values=0,
            )
            return FieldCrop(0, "slot", (0, 0, 46, 70), padded)

        self.assertEqual(_classify_h_r_glyph(crop(h_pixels)), "H")
        self.assertEqual(_classify_h_r_glyph(crop(r_pixels)), "R")
        self.assertEqual(_classify_d_f_p_glyph(crop(d_pixels)), "D")
        self.assertEqual(_classify_d_f_p_glyph(crop(f_pixels)), "F")
        self.assertEqual(_classify_d_f_p_glyph(crop(p_pixels)), "P")

    def test_opencv_recovers_missing_leading_one_in_team_kills(self) -> None:
        active_cv2 = require_opencv()
        pixels = np.zeros((40, 50, 3), dtype=np.uint8)
        active_cv2.line(pixels, (12, 5), (12, 34), (255, 255, 255), 2)
        active_cv2.line(pixels, (16, 5), (29, 5), (255, 255, 255), 2)
        active_cv2.line(pixels, (29, 5), (21, 34), (255, 255, 255), 2)

        corrected = _reconcile_missing_leading_one(
            FieldReading(value=7, confidence=0.99),
            FieldCrop(0, "kills", (0, 0, 50, 40), pixels),
        )

        self.assertEqual(corrected.value, 17)
        self.assertEqual(corrected.source, "ocr+opencv_digit_topology")
        self.assertFalse(corrected.review_required)

    def test_opencv_resolves_conflicted_thirty_and_terminal_six(self) -> None:
        active_cv2 = require_opencv()
        thirty_pixels = np.zeros((30, 45, 3), dtype=np.uint8)
        three = [
            "..#.#.",
            "######",
            "##...#",
            ".....#",
            ".....#",
            "..####",
            ".....#",
            ".....#",
            "#....#",
            "##...#",
            ".#####",
        ]
        for y, line in enumerate(three, start=7):
            for x, value in enumerate(line, start=10):
                if value == "#":
                    thirty_pixels[y, x] = 255
        active_cv2.rectangle(thirty_pixels, (24, 7), (31, 17), (255, 255, 255), 1)
        thirty = _reconcile_three_misread_as_four(
            FieldReading(
                value=40,
                confidence=0.6,
                raw_text="gray_160:40 | otsu:30",
                review_required=True,
            ),
            FieldCrop(0, "kills", (0, 0, 45, 30), thirty_pixels),
        )

        sixteen_pixels = np.zeros((30, 70, 3), dtype=np.uint8)
        active_cv2.line(sixteen_pixels, (30, 6), (30, 23), (255, 255, 255), 2)
        active_cv2.rectangle(sixteen_pixels, (42, 6), (52, 23), (255, 255, 255), 2)
        active_cv2.line(sixteen_pixels, (42, 14), (52, 14), (255, 255, 255), 2)
        sixteen = _reconcile_terminal_six(
            FieldReading(value=16, confidence=0.6, review_required=True),
            FieldCrop(0, "kills", (0, 0, 70, 30), sixteen_pixels),
        )

        self.assertEqual(thirty.value, 30)
        self.assertFalse(thirty.review_required)
        self.assertEqual(sixteen.value, 16)
        self.assertFalse(sixteen.review_required)

    def test_opencv_promotes_majority_supported_multi_digit_kills(self) -> None:
        active_cv2 = require_opencv()
        pixels = np.zeros((30, 55, 3), dtype=np.uint8)
        active_cv2.rectangle(pixels, (30, 8), (35, 19), (255, 255, 255), 1)
        active_cv2.rectangle(pixels, (39, 8), (44, 19), (255, 255, 255), 1)

        promoted = _reconcile_supported_numeric(
            FieldReading(
                value=22,
                confidence=0.81,
                raw_text="gray_160:22 | gray_200:2c | otsu:ee",
                review_required=True,
            ),
            FieldCrop(0, "kills", (0, 0, 55, 30), pixels),
        )

        self.assertEqual(promoted.value, 22)
        self.assertEqual(promoted.confidence, 0.86)
        self.assertFalse(promoted.review_required)

    def test_opencv_promotes_one_uncontested_visible_three(self) -> None:
        active_cv2 = require_opencv()
        pixels = np.zeros((30, 50, 3), dtype=np.uint8)
        three = [
            "..###.",
            ".#####",
            "##...#",
            ".....#",
            ".....#",
            "..####",
            ".....#",
            ".....#",
            "##...#",
            "##...#",
            ".#####",
        ]
        for y, line in enumerate(three, start=7):
            for x, value in enumerate(line, start=30):
                if value == "#":
                    pixels[y, x] = 255

        promoted = _reconcile_uncontested_three(
            FieldReading(
                value=3,
                confidence=0.78,
                raw_text="otsu:3",
                review_required=True,
            ),
            FieldCrop(0, "kills", (0, 0, 50, 30), pixels),
        )

        self.assertEqual(promoted.value, 3)
        self.assertEqual(promoted.confidence, 0.86)
        self.assertFalse(promoted.review_required)

    def test_opencv_corrects_a_terminal_nine_when_the_glyph_has_two_holes(
        self,
    ) -> None:
        active_cv2 = require_opencv()
        pixels = np.zeros((40, 30, 3), dtype=np.uint8)
        active_cv2.rectangle(pixels, (9, 5), (21, 34), (255, 255, 255), 3)
        active_cv2.line(pixels, (9, 19), (21, 19), (255, 255, 255), 3)
        reading = FieldReading(value=29, confidence=0.86)

        corrected = _reconcile_eight_nine(
            reading,
            FieldCrop(0, "kills", (0, 0, 30, 40), pixels),
        )

        self.assertEqual(corrected.value, 28)
        self.assertEqual(corrected.source, "ocr+opencv_digit_topology")
        self.assertFalse(corrected.review_required)

    def test_opencv_recovers_fixed_eleven_and_seventeen_kill_glyphs(self) -> None:
        active_cv2 = require_opencv()

        def pixels() -> np.ndarray:
            value = np.zeros((40, 60, 3), dtype=np.uint8)
            active_cv2.rectangle(
                value,
                (2, 5),
                (22, 25),
                (255, 255, 255),
                -1,
            )
            active_cv2.line(value, (32, 10), (32, 28), (255, 255, 255), 3)
            return value

        eleven_pixels = pixels()
        active_cv2.line(
            eleven_pixels,
            (39, 10),
            (39, 28),
            (255, 255, 255),
            3,
        )
        eleven = _reconcile_repeated_one(
            FieldReading(value=1, confidence=0.86),
            FieldCrop(0, "kills", (0, 0, 60, 40), eleven_pixels),
        )

        seventeen_pixels = pixels()
        active_cv2.line(
            seventeen_pixels,
            (40, 10),
            (48, 10),
            (255, 255, 255),
            3,
        )
        active_cv2.line(
            seventeen_pixels,
            (47, 10),
            (47, 28),
            (255, 255, 255),
            3,
        )
        seventeen = _reconcile_unreadable_seventeen(
            FieldReading(value=None, confidence=0, review_required=True),
            FieldCrop(0, "kills", (0, 0, 60, 40), seventeen_pixels),
        )
        seventeen_from_partial_ocr = _reconcile_unreadable_seventeen(
            FieldReading(value=1, confidence=0.4, review_required=True),
            FieldCrop(0, "kills", (0, 0, 60, 40), seventeen_pixels),
        )
        seventeen_from_misread_eleven = _reconcile_unreadable_seventeen(
            FieldReading(value=11, confidence=0.9),
            FieldCrop(0, "kills", (0, 0, 60, 40), seventeen_pixels),
        )
        verified_eleven = _reconcile_unreadable_seventeen(
            FieldReading(value=11, confidence=0.9),
            FieldCrop(0, "kills", (0, 0, 60, 40), eleven_pixels),
        )

        self.assertEqual(eleven.value, 11)
        self.assertEqual(seventeen.value, 17)
        self.assertEqual(seventeen_from_partial_ocr.value, 17)
        self.assertEqual(seventeen_from_misread_eleven.value, 17)
        self.assertEqual(verified_eleven.value, 11)
        self.assertFalse(eleven.review_required)
        self.assertFalse(seventeen.review_required)
        self.assertFalse(seventeen_from_partial_ocr.review_required)
        self.assertFalse(seventeen_from_misread_eleven.review_required)

    def test_opencv_topology_disambiguates_tied_d_and_f_markers(self) -> None:
        active_cv2 = require_opencv()
        bgr = active_cv2.cvtColor(
            np.array([[[24, 225, 187]]], dtype=np.uint8),
            active_cv2.COLOR_HSV2BGR,
        )[0, 0]
        marker = FieldCrop(
            row_index=0,
            field="slot_color",
            bbox=(0, 0, 20, 20),
            pixels=np.tile(bgr, (20, 20, 1)),
        )
        layout = {
            "slot_color_palette": {
                "D": [24, 225, 187],
                "F": [24, 225, 187],
                "P": [24, 222, 172],
            },
            "slot_color_max_distance": 18,
            "slot_color_ambiguity_margin": 2,
            "ocr": {"minimum_confidence": 0.82},
        }
        unreadable = FieldReading(
            value=None,
            confidence=0,
            review_required=True,
        )
        closed_pixels = np.zeros((40, 30, 3), dtype=np.uint8)
        active_cv2.rectangle(closed_pixels, (5, 5), (24, 34), bgr.tolist(), 4)
        open_pixels = np.zeros((40, 30, 3), dtype=np.uint8)
        active_cv2.line(open_pixels, (6, 5), (6, 34), bgr.tolist(), 4)
        active_cv2.line(open_pixels, (6, 6), (24, 6), bgr.tolist(), 4)
        active_cv2.line(open_pixels, (6, 19), (20, 19), bgr.tolist(), 4)

        resolved_d = _reconcile_slot_marker(
            unreadable,
            marker,
            layout,
            FieldCrop(0, "slot", (0, 0, 30, 40), closed_pixels),
        )
        resolved_f = _reconcile_slot_marker(
            unreadable,
            marker,
            layout,
            FieldCrop(0, "slot", (0, 0, 30, 40), open_pixels),
        )
        p_pixels = np.zeros((40, 30, 3), dtype=np.uint8)
        active_cv2.line(p_pixels, (6, 8), (6, 31), bgr.tolist(), 4)
        active_cv2.rectangle(p_pixels, (6, 8), (24, 20), bgr.tolist(), 4)
        resolved_p = _reconcile_slot_marker(
            unreadable,
            marker,
            layout,
            FieldCrop(0, "slot", (0, 0, 30, 40), p_pixels),
        )

        open_d_pixels = np.zeros((40, 30, 3), dtype=np.uint8)
        active_cv2.line(open_d_pixels, (8, 8), (8, 31), bgr.tolist(), 4)
        active_cv2.line(open_d_pixels, (8, 8), (18, 8), bgr.tolist(), 4)
        active_cv2.line(open_d_pixels, (21, 11), (21, 31), bgr.tolist(), 4)
        active_cv2.line(open_d_pixels, (8, 31), (21, 31), bgr.tolist(), 4)
        resolved_open_d = _reconcile_slot_marker(
            unreadable,
            marker,
            layout,
            FieldCrop(0, "slot", (0, 0, 30, 40), open_d_pixels),
        )

        self.assertEqual(resolved_d.value, "D")
        self.assertEqual(resolved_f.value, "F")
        self.assertEqual(resolved_p.value, "P")
        self.assertEqual(resolved_open_d.value, "D")
        self.assertFalse(resolved_d.review_required)
        self.assertFalse(resolved_f.review_required)
        self.assertFalse(resolved_p.review_required)
        self.assertFalse(resolved_open_d.review_required)

    def test_opencv_recovers_fixed_eighteen_when_ocr_variants_disagree(
        self,
    ) -> None:
        active_cv2 = require_opencv()
        pixels = np.zeros((35, 55, 3), dtype=np.uint8)
        active_cv2.line(pixels, (28, 9), (28, 25), (255, 255, 255), 3)
        active_cv2.rectangle(pixels, (35, 9), (45, 25), (255, 255, 255), 2)
        active_cv2.line(pixels, (35, 17), (45, 17), (255, 255, 255), 2)

        resolved = _reconcile_fixed_eighteen(
            FieldReading(
                value=14,
                confidence=0.6,
                raw_text="gray_160:19 | gray_200:14 | otsu:16",
                review_required=True,
            ),
            FieldCrop(0, "kills", (0, 0, 55, 35), pixels),
        )

        self.assertEqual(resolved.value, 18)
        self.assertEqual(resolved.confidence, 0.93)
        self.assertFalse(resolved.review_required)

    def test_opencv_verifies_only_a_single_large_closed_zero_glyph(self) -> None:
        ring = np.full((80, 60), 255, dtype=np.uint8)
        active_cv2 = require_opencv()
        active_cv2.rectangle(ring, (12, 8), (47, 71), 0, 6)
        unreadable = FieldReading(
            value=None,
            confidence=0,
            review_required=True,
        )
        crop = FieldCrop(
            row_index=0,
            field="kills",
            bbox=(0, 0, 10, 10),
            pixels=np.zeros((10, 10, 3), dtype=np.uint8),
        )
        with patch(
            "modules.scoreboard.ocr_processor.preprocessing_variants",
            return_value={"gray_160": ring},
        ):
            resolved = _reconcile_zero_kill(
                unreadable,
                crop,
                {"ocr": {"upscale": 6}},
            )

        self.assertEqual(resolved.value, 0)
        self.assertEqual(resolved.source, "ocr+opencv_closed_zero")
        self.assertFalse(resolved.review_required)

        with patch(
            "modules.scoreboard.ocr_processor.preprocessing_variants",
            return_value={"gray_160": ring},
        ):
            promoted = _reconcile_zero_kill(
                FieldReading(
                    value=0,
                    confidence=0,
                    review_required=True,
                ),
                crop,
                {"ocr": {"upscale": 6}},
            )

        self.assertEqual(promoted.value, 0)
        self.assertEqual(promoted.confidence, 0.93)
        self.assertFalse(promoted.review_required)

    def test_tesseract_batch_assigns_tokens_to_their_fixed_rows(self) -> None:
        payload = {
            "text": ["O", "M"],
            "conf": ["95", "90"],
            "top": [38, 84],
            "height": [5, 5],
        }
        with patch(
            "modules.scoreboard.ocr_processor.pytesseract.image_to_data",
            return_value=payload,
        ) as image_to_data:
            attempts = PytesseractEngine().recognize_many(
                [
                    np.zeros((10, 10), dtype=np.uint8),
                    np.zeros((10, 10), dtype=np.uint8),
                ],
                "slot",
                "raw",
            )

        self.assertEqual([attempt.text for attempt in attempts], ["O", "M"])
        self.assertEqual([attempt.confidence for attempt in attempts], [0.95, 0.9])
        self.assertEqual(image_to_data.call_count, 1)
        self.assertIn("--psm 6", image_to_data.call_args.kwargs["config"])

    def test_placement_batch_keeps_hash_and_uses_numeric_single_column_mode(
        self,
    ) -> None:
        payload = {
            "text": ["#4"],
            "conf": ["96"],
            "top": [38],
            "height": [5],
        }
        with patch(
            "modules.scoreboard.ocr_processor.pytesseract.image_to_data",
            return_value=payload,
        ) as image_to_data:
            attempts = PytesseractEngine().recognize_many(
                [np.zeros((10, 10), dtype=np.uint8)],
                "placement",
                "inverted_otsu",
            )

        self.assertEqual(attempts[0].text, "#4")
        config = image_to_data.call_args.kwargs["config"]
        self.assertIn("--psm 4", config)
        self.assertIn("tessedit_char_whitelist=#0123456789", config)
        self.assertIn("user_defined_dpi=300", config)
        self.assertIn("classify_bln_numeric_mode=1", config)

    def test_reader_extracts_known_rows_and_infers_medal_placement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout_path = Path(directory, "layout.json")
            layout_path.write_text(json.dumps(pipeline_layout()), encoding="utf-8")
            fake_image = np.zeros((300, 300, 3), dtype=np.uint8)
            loaded = LoadedImage(
                path=Path(directory, "round1.png"),
                original_bytes=b"round1",
                original_sha256="a" * 64,
                pixels=fake_image,
            )
            crops = [
                FieldCrop(
                    row_index=row_index,
                    field=field,
                    bbox=(0, 0, 10, 10),
                    pixels=np.zeros((10, 10, 3), dtype=np.uint8),
                )
                for row_index in range(3)
                for field in ("placement", "slot", "kills")
            ]
            reader = LocalScoreboardReader(
                layout_path=layout_path,
                engine=FakeEngine(),
                team_registry=TeamRegistry(
                    {
                        "O": "LGT - AKATSOKE",
                        "M": "TEAM M",
                        "R": "TEAM R",
                    }
                ),
            )
            with (
                patch(
                    "modules.scoreboard.ocr_processor.load_image",
                    return_value=loaded,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.normalize_image",
                    return_value=fake_image,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.crop_scoreboard_fields",
                    return_value=crops,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.preprocessing_variants",
                    side_effect=lambda pixels, upscale, field=None: {"test": pixels},
                ),
            ):
                result = reader.read(loaded.path)

        self.assertEqual(len(result.rows), 3)
        first = result.rows[0]
        self.assertEqual(first.placement.value, 1)
        self.assertEqual(first.placement.source, "sequence_inferred")
        self.assertEqual(first.slot.value, "O")
        self.assertEqual(first.kills.value, 65)
        self.assertEqual(first.team_name, "LGT - AKATSOKE")
        self.assertEqual(first.total_score, 85)
        self.assertFalse(first.review_required)
        self.assertFalse(result.as_dict()["reader"]["paid_ai_used"])

    def test_reader_batches_fixed_rows_by_field_and_variant(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout_path = Path(directory, "layout.json")
            layout_path.write_text(json.dumps(pipeline_layout()), encoding="utf-8")
            fake_image = np.zeros((300, 300, 3), dtype=np.uint8)
            loaded = LoadedImage(
                path=Path(directory, "round1.png"),
                original_bytes=b"round1",
                original_sha256="a" * 64,
                pixels=fake_image,
            )
            crops = [
                FieldCrop(
                    row_index=row_index,
                    field=field,
                    bbox=(0, 0, 10, 10),
                    pixels=np.zeros((10, 10, 3), dtype=np.uint8),
                )
                for row_index in range(3)
                for field in ("placement", "slot", "kills")
            ]
            engine = FakeBatchEngine()
            reader = LocalScoreboardReader(
                layout_path=layout_path,
                engine=engine,
                team_registry=TeamRegistry(
                    {
                        "O": "LGT - AKATSOKE",
                        "M": "TEAM M",
                        "R": "TEAM R",
                    }
                ),
            )
            with (
                patch(
                    "modules.scoreboard.ocr_processor.load_image",
                    return_value=loaded,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.normalize_image",
                    return_value=fake_image,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.crop_scoreboard_fields",
                    return_value=crops,
                ),
                patch(
                    "modules.scoreboard.ocr_processor.preprocessing_variants",
                    side_effect=lambda pixels, upscale, field=None: {"test": pixels},
                ),
            ):
                result = reader.read(loaded.path)

        self.assertEqual(
            engine.calls,
            [
                ("placement", "test", 3),
                ("slot", "test", 3),
                ("kills", "test", 3),
            ],
        )
        self.assertEqual(engine.single_calls, [])
        self.assertEqual([row.slot.value for row in result.rows], ["O", "M", "R"])
        self.assertEqual([row.kills.value for row in result.rows], [65, 7, 31])

    def test_fast_mode_uses_only_bounded_batch_variants(self) -> None:
        layout = pipeline_layout()
        layout["ocr"]["fast_mode"] = True
        crop = FieldCrop(
            row_index=0,
            field="kills",
            bbox=(0, 0, 10, 10),
            pixels=np.zeros((10, 10, 3), dtype=np.uint8),
        )
        reader = LocalScoreboardReader(
            layout_path="layout.json",
            engine=FakeBatchEngine(),
        )
        variants = reader._preprocessing_variants(crop, layout)

        self.assertEqual(list(variants), ["gray_160", "gray_200", "otsu"])


if __name__ == "__main__":
    unittest.main()
