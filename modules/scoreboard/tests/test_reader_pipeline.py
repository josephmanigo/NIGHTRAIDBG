from __future__ import annotations

import json
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest.mock import patch

import numpy as np

from modules.scoreboard.image_processor import FieldCrop, LoadedImage
from modules.scoreboard.ocr_processor import (
    LocalScoreboardReader,
    OcrAttempt,
    PytesseractEngine,
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


if __name__ == "__main__":
    unittest.main()
