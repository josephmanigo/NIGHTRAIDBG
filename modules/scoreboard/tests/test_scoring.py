from __future__ import annotations

import unittest

from modules.scoreboard.scoring import placement_points, score_result


class ScoringTests(unittest.TestCase):
    def test_placement_boundaries(self) -> None:
        expected = {
            1: 20,
            2: 16,
            3: 13,
            4: 10,
            5: 8,
            6: 5,
            10: 5,
            11: 2,
            15: 2,
            16: 1,
            18: 1,
            19: 0,
            25: 0,
        }
        self.assertEqual(
            {place: placement_points(place) for place in expected},
            expected,
        )

    def test_example_total_is_85(self) -> None:
        self.assertEqual(
            score_result(1, 65),
            {
                "placement": 1,
                "placement_points": 20,
                "kills": 65,
                "kill_points": 65,
                "total_score": 85,
            },
        )

    def test_invalid_values_are_rejected(self) -> None:
        for value in (0, -1, True, 1.5, "1"):
            with self.subTest(place=value):
                with self.assertRaises(ValueError):
                    placement_points(value)  # type: ignore[arg-type]
        for value in (-1, True, 1.5, "1"):
            with self.subTest(kills=value):
                with self.assertRaises(ValueError):
                    score_result(1, value)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
