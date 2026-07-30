"""Processing-log contract; persistence remains owned by the Node Supabase store."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True)
class ProcessingLog:
    screenshot_filename: str
    screenshot_sha256: str
    status: str
    extracted_values: tuple[dict[str, Any], ...]
    final_scores: tuple[dict[str, Any], ...]
    processed_at: str
    error: str | None = None

    @classmethod
    def create(
        cls,
        *,
        screenshot_filename: str,
        screenshot_sha256: str,
        status: str,
        extracted_values: list[dict[str, Any]],
        final_scores: list[dict[str, Any]],
        error: str | None = None,
    ) -> "ProcessingLog":
        return cls(
            screenshot_filename=screenshot_filename,
            screenshot_sha256=screenshot_sha256,
            status=status,
            extracted_values=tuple(extracted_values),
            final_scores=tuple(final_scores),
            processed_at=datetime.now(UTC).isoformat(),
            error=error,
        )

    def as_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["extracted_values"] = list(self.extracted_values)
        result["final_scores"] = list(self.final_scores)
        return result
