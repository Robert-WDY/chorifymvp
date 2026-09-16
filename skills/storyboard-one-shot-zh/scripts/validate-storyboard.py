"""Deterministic validator for storyboard-one-shot-zh plans."""

from typing import Any, Dict, List, Tuple


EPSILON = 0.02
RECOMMENDED_LAYOUTS: Dict[int, Tuple[int, int, str]] = {
    2: (2, 1, "16:9"),
    3: (3, 1, "16:9"),
    4: (2, 2, "16:9"),
    5: (3, 2, "16:9"),
    6: (3, 2, "16:9"),
    7: (4, 2, "3:1"),
    8: (4, 2, "3:1"),
    9: (3, 3, "16:9"),
}


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("not a number")
    return float(value)


def _blank(value: Any) -> bool:
    return not isinstance(value, str) or not value.strip()


def main(input: dict):
    errors: List[str] = []
    warnings: List[str] = []
    segments = input.get("segments", [])

    if input.get("underPanelInfo") is not False:
        errors.append("极简模式禁止画下制作信息栏，underPanelInfo 必须为 false")

    arrow_mode = input.get("arrowMode")
    visible_requested = input.get("visibleArrowsRequested") is True
    if arrow_mode == "visible" and not visible_requested:
        errors.append("用户未明确要求可见箭头，arrowMode 不得设为 visible")
    if arrow_mode == "hidden" and visible_requested:
        warnings.append("用户要求了可见箭头，但当前方案仍为 hidden；请核对用户意图")

    if not isinstance(segments, list) or not segments:
        errors.append("至少需要一个故事板分段")
        segments = []

    total_panels = 0
    total_duration = 0.0
    seen_ids = set()

    for segment_index, segment in enumerate(segments, start=1):
        prefix = f"分段{segment_index}"
        if not isinstance(segment, dict):
            errors.append(f"{prefix}必须是对象")
            continue

        segment_id = str(segment.get("id", "")).strip()
        if not segment_id:
            errors.append(f"{prefix}缺少 id")
        elif segment_id in seen_ids:
            errors.append(f"{prefix}的 id 重复：{segment_id}")
        else:
            seen_ids.add(segment_id)

        try:
            duration = _number(segment.get("durationSeconds"))
        except ValueError:
            duration = 0.0
            errors.append(f"{prefix}的 durationSeconds 必须是数字")
        if duration < 1 or duration > 15:
            errors.append(f"{prefix}时长必须在1–15秒之间")
        total_duration += max(duration, 0.0)

        panel_count = segment.get("panelCount")
        columns = segment.get("columns")
        rows = segment.get("rows")
        if not isinstance(panel_count, int) or isinstance(panel_count, bool):
            panel_count = 0
            errors.append(f"{prefix}的 panelCount 必须是整数")
        if panel_count < 2 or panel_count > 9:
            errors.append(f"{prefix}画格数必须在2–9格之间")
        total_panels += max(panel_count, 0)

        if not isinstance(columns, int) or isinstance(columns, bool) or columns < 1:
            columns = 0
            errors.append(f"{prefix}的 columns 必须是正整数")
        if not isinstance(rows, int) or isinstance(rows, bool) or rows < 1:
            rows = 0
            errors.append(f"{prefix}的 rows 必须是正整数")

        capacity = columns * rows
        if capacity < panel_count:
            errors.append(f"{prefix}网格容量小于画格数")
        elif columns and capacity - panel_count >= columns:
            errors.append(f"{prefix}存在整行空白；应缩减 rows")

        recommended = RECOMMENDED_LAYOUTS.get(panel_count)
        if recommended:
            expected_columns, expected_rows, expected_ratio = recommended
            if (columns, rows) != (expected_columns, expected_rows):
                warnings.append(
                    f"{prefix}推荐使用{expected_columns}×{expected_rows}网格，当前为{columns}×{rows}"
                )
            if segment.get("aspectRatio") != expected_ratio:
                warnings.append(
                    f"{prefix}推荐画幅为{expected_ratio}，当前为{segment.get('aspectRatio')}"
                )

        panels = segment.get("panels", [])
        if not isinstance(panels, list):
            panels = []
            errors.append(f"{prefix}的 panels 必须是数组")
        if len(panels) != panel_count:
            errors.append(f"{prefix}的 panels 数量必须等于 panelCount")

        expected_numbers = list(range(1, len(panels) + 1))
        actual_numbers = [panel.get("number") if isinstance(panel, dict) else None for panel in panels]
        if actual_numbers != expected_numbers:
            errors.append(f"{prefix}画格编号必须从1开始连续递增且不得重复")

        previous_end = 0.0
        for panel_index, panel in enumerate(panels, start=1):
            panel_prefix = f"{prefix} P{panel_index:02d}"
            if not isinstance(panel, dict):
                errors.append(f"{panel_prefix}必须是对象")
                continue

            try:
                start = _number(panel.get("startSeconds"))
                end = _number(panel.get("endSeconds"))
            except ValueError:
                errors.append(f"{panel_prefix}时码必须是数字")
                continue

            if abs(start - previous_end) > EPSILON:
                errors.append(f"{panel_prefix}起始时码必须紧接上一格结束时码")
            if end <= start:
                errors.append(f"{panel_prefix}结束时码必须大于起始时码")
            if end > duration + EPSILON:
                errors.append(f"{panel_prefix}结束时码超过本段时长")
            previous_end = end

            title = panel.get("title")
            if _blank(title):
                errors.append(f"{panel_prefix}缺少短标题")
            elif len(title.strip()) > 8:
                warnings.append(f"{panel_prefix}短标题超过8个字符，可能影响可见文字稳定性")

            required_fields = (
                "shotSize",
                "cameraPosition",
                "cameraState",
                "action",
                "function",
                "dialogue",
                "voiceover",
                "sound",
                "music",
            )
            missing = [field for field in required_fields if _blank(panel.get(field))]
            if missing:
                errors.append(f"{panel_prefix}缺少生产字段：{', '.join(missing)}")

        if panels and abs(previous_end - duration) > EPSILON:
            errors.append(f"{prefix}最后一格结束时码必须等于本段时长")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "segmentCount": len(segments),
            "totalPanels": total_panels,
            "totalDurationSeconds": round(total_duration, 3),
        },
    }
