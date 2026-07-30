"""NIGHTRAID scrimmage scoring rules used for local previews."""

from __future__ import annotations


def placement_points(place: int) -> int:
    """Return placement points for a valid positive placement."""

    if isinstance(place, bool) or not isinstance(place, int) or place < 1:
        raise ValueError("place must be a positive integer")
    if place == 1:
        return 20
    if place == 2:
        return 16
    if place == 3:
        return 13
    if place == 4:
        return 10
    if place == 5:
        return 8
    if place <= 10:
        return 5
    if place <= 15:
        return 2
    if place <= 18:
        return 1
    return 0


def score_result(place: int, kills: int) -> dict[str, int]:
    """Calculate a validation preview; spreadsheet formulas remain official."""

    if isinstance(kills, bool) or not isinstance(kills, int) or kills < 0:
        raise ValueError("kills must be a non-negative integer")
    place_points = placement_points(place)
    return {
        "placement": place,
        "placement_points": place_points,
        "kills": kills,
        "kill_points": kills,
        "total_score": place_points + kills,
    }
