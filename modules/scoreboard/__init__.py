"""Free, local NIGHTRAID scoreboard screenshot processing."""

from .ocr_processor import LocalScoreboardReader
from .scoring import placement_points, score_result
from .team_manager import TeamRegistry

__all__ = [
    "LocalScoreboardReader",
    "TeamRegistry",
    "placement_points",
    "score_result",
]
