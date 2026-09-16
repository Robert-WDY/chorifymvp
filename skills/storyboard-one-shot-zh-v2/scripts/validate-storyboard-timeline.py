import math


TOLERANCE = 0.001


def _issue(board_id, shot_id, message):
    return {"boardId": board_id, "shotId": shot_id, "message": message}


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _recommended_range(duration):
    if duration <= 5:
        return 2, 4
    if duration <= 10:
        return 4, 6
    return 5, 9


def main(input: dict):
    boards = input.get("boards", [])
    errors = []
    warnings = []
    summaries = []
    previous_full_end = None

    if not boards:
        errors.append(_issue("", "", "boards 不能为空"))

    for board_index, board in enumerate(boards):
        board_id = board.get("boardId", "")
        full_start = board.get("fullStart")
        full_end = board.get("fullEnd")
        duration = board.get("segmentDuration")
        shots = board.get("shots", [])

        if not all(_finite(v) for v in (full_start, full_end, duration)):
            errors.append(_issue(board_id, "", "全片范围和本段时长必须是有限数字"))
            continue
        if duration < 1 or duration > 15:
            errors.append(_issue(board_id, "", "本段时长必须为 1–15 秒"))
        if full_end <= full_start:
            errors.append(_issue(board_id, "", "fullEnd 必须大于 fullStart"))
        if abs((full_end - full_start) - duration) > TOLERANCE:
            errors.append(_issue(board_id, "", "全片时间范围长度必须等于本段时长"))
        if previous_full_end is not None and abs(full_start - previous_full_end) > TOLERANCE:
            errors.append(_issue(board_id, "", "当前故事板的 fullStart 必须衔接上一张的 fullEnd"))
        previous_full_end = full_end

        if not board.get("startState", "").strip():
            warnings.append(_issue(board_id, "", "缺少本段开始状态"))
        if not board.get("endState", "").strip():
            warnings.append(_issue(board_id, "", "缺少本段结束状态"))
        if not shots:
            errors.append(_issue(board_id, "", "每张故事板至少需要一个镜头"))

        low, high = _recommended_range(duration)
        if shots and not (low <= len(shots) <= high):
            warnings.append(_issue(board_id, "", "画格数不在该时长的推荐范围内"))
        if len(shots) > 9:
            errors.append(_issue(board_id, "", "单张故事板不得超过 9 格"))

        seen_ids = set()
        previous_end = 0.0
        required_fields = ("function", "shotSize", "cameraPosition", "cameraState", "dialogue", "vo", "sound", "music")

        for shot_index, shot in enumerate(shots):
            shot_id = shot.get("shotId", "")
            start = shot.get("start")
            end = shot.get("end")
            expected_id = "S%02d" % (shot_index + 1)

            if shot_id in seen_ids:
                errors.append(_issue(board_id, shot_id, "镜号重复"))
            seen_ids.add(shot_id)
            if shot_id != expected_id:
                warnings.append(_issue(board_id, shot_id, "镜号建议按 S01、S02 连续编号"))
            if not _finite(start) or not _finite(end):
                errors.append(_issue(board_id, shot_id, "镜头起止时间必须是有限数字"))
                continue
            if end <= start:
                errors.append(_issue(board_id, shot_id, "镜头结束时间必须大于开始时间"))
            if abs(start - previous_end) > TOLERANCE:
                errors.append(_issue(board_id, shot_id, "镜头时码必须连续且从本段 0 秒开始"))
            previous_end = end

            for field in required_fields:
                value = shot.get(field)
                if not isinstance(value, str) or not value.strip():
                    errors.append(_issue(board_id, shot_id, "缺少必填字段：" + field))

        if shots and abs(previous_end - duration) > TOLERANCE:
            errors.append(_issue(board_id, "", "最后一个镜头结束时间必须等于本段时长"))

        summaries.append({
            "boardId": board_id,
            "fullStart": full_start,
            "fullEnd": full_end,
            "segmentDuration": duration,
            "shotCount": len(shots),
        })

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "summaries": summaries,
    }

