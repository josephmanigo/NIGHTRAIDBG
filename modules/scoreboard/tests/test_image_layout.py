from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from modules.scoreboard.image_processor import (
    crop_scoreboard_fields,
    isolate_kill_digits,
    load_layout,
    select_layout_for_image,
    validate_layout,
)


def test_layout() -> dict[str, object]:
    return {
        "id": "test-layout",
        "version": 1,
        "coordinate_space": 1000,
        "reference_size": {"width": 300, "height": 200},
        "aspect_ratio_tolerance": 0.01,
        "leaderboard_region": [0, 0, 1000, 1000],
        "rows": [
            [0, 0, 1000, 500],
            [0, 500, 1000, 500],
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


class ImageLayoutTests(unittest.TestCase):
    def test_layout_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "layout.json")
            path.write_text(json.dumps(test_layout()), encoding="utf-8")
            self.assertEqual(load_layout(path)["id"], "test-layout")

    def test_production_layouts_infer_numbered_places_from_the_image(self) -> None:
        scoreboard_directory = Path(__file__).parents[1]
        for filename in (
            "layout.json",
            "layout-narrow-full.json",
            "layout-narrow-padded.json",
            "layout-wide.json",
            "layout-wide-full.json",
        ):
            layout = load_layout(scoreboard_directory / filename)
            self.assertEqual(layout.get("placement_hints"), {"0": 1})

    def test_invalid_rect_is_rejected(self) -> None:
        layout = test_layout()
        layout["leaderboard_region"] = [900, 0, 200, 1000]
        with self.assertRaises(ValueError):
            validate_layout(layout)

    def test_alternate_layout_must_remain_beside_primary(self) -> None:
        layout = test_layout()
        layout["alternate_layouts"] = ["../outside.json"]
        with self.assertRaises(ValueError):
            validate_layout(layout)

    def test_fast_mode_must_be_boolean(self) -> None:
        layout = test_layout()
        layout["ocr"]["fast_mode"] = "yes"
        with self.assertRaises(ValueError):
            validate_layout(layout)

    def test_fast_fallback_fields_are_limited_to_score_fields(self) -> None:
        layout = test_layout()
        layout["ocr"]["individual_fallback_fields"] = ["avatar"]
        with self.assertRaises(ValueError):
            validate_layout(layout)

    def test_kill_crop_removes_the_large_left_skull_and_keeps_digits(self) -> None:
        mask = np.zeros((30, 60), dtype=np.uint8)
        mask[5:25, 2:22] = 255
        mask[8:24, 32:38] = 255
        mask[8:24, 44:50] = 255

        digits = isolate_kill_digits(mask)

        self.assertEqual(int(digits[:, :23].sum()), 0)
        self.assertGreater(int(digits[:, 30:].sum()), 0)

    def test_closest_fixed_layout_is_selected_by_aspect_ratio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            primary_path = Path(directory, "layout.json")
            alternate_path = Path(directory, "wide.json")
            primary = test_layout()
            primary["alternate_layouts"] = ["wide.json"]
            alternate = test_layout()
            alternate["id"] = "wide-layout"
            alternate["reference_size"] = {"width": 400, "height": 200}
            primary_path.write_text(json.dumps(primary), encoding="utf-8")
            alternate_path.write_text(json.dumps(alternate), encoding="utf-8")

            selected = select_layout_for_image(
                primary_path,
                np.zeros((200, 400, 3), dtype=np.uint8),
            )

        self.assertEqual(selected["id"], "wide-layout")

    def test_fixed_coordinates_produce_expected_field_crops(self) -> None:
        layout = validate_layout(test_layout())
        image = np.zeros((200, 300, 3), dtype=np.uint8)
        expected = {
            (0, "placement"): 20,
            (0, "slot"): 40,
            (0, "kills"): 60,
            (1, "placement"): 80,
            (1, "slot"): 100,
            (1, "kills"): 120,
        }
        for row_index, y_range in enumerate((slice(0, 100), slice(100, 200))):
            image[y_range, 0:100] = expected[(row_index, "placement")]
            image[y_range, 100:200] = expected[(row_index, "slot")]
            image[y_range, 200:300] = expected[(row_index, "kills")]
        crops = crop_scoreboard_fields(image, layout)
        self.assertEqual(len(crops), 6)
        for crop in crops:
            self.assertAlmostEqual(
                float(crop.pixels.mean()),
                expected[(crop.row_index, crop.field)],
                delta=1.0,
            )


if __name__ == "__main__":
    unittest.main()
