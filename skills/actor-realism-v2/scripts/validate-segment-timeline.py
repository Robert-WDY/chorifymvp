import math


def _finite_number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(name + " must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(name + " must be finite")
    return number


def main(input: dict):
    if not isinstance(input, dict):
        raise ValueError("input must be an object")

    total_duration = _finite_number(input.get("totalDuration"), "totalDuration")
    segments = input.get("segments")
    max_segment_duration = _finite_number(input.get("maxSegmentDuration", 15), "maxSegmentDuration")
    tolerance = _finite_number(input.get("tolerance", 0.01), "tolerance")

    if total_duration <= 0:
        raise ValueError("totalDuration must be greater than 0")
    if max_segment_duration <= 0:
        raise ValueError("maxSegmentDuration must be greater than 0")
    if tolerance < 0 or tolerance > 0.5:
        raise ValueError("tolerance must be between 0 and 0.5")
    if not isinstance(segments, list) or not segments:
        raise ValueError("segments must be a non-empty array")

    errors = []
    warnings = []
    seen_ids = set()
    normalized = []
    previous_end = 0.0
    duration_sum = 0.0

    for index, segment in enumerate(segments):
        label = "segment " + str(index + 1)
        if not isinstance(segment, dict):
            raise ValueError(label + " must be an object")

        segment_id = segment.get("id")
        prompt = segment.get("prompt")
        if not isinstance(segment_id, str) or not segment_id.strip():
            raise ValueError(label + " id must be a non-empty string")
        if not isinstance(prompt, str) or not prompt.strip():
            errors.append(segment_id + " 缺少独立完整提示词")
        if segment_id in seen_ids:
            errors.append("段落 id 重复：" + segment_id)
        seen_ids.add(segment_id)

        start = _finite_number(segment.get("start"), label + " start")
        end = _finite_number(segment.get("end"), label + " end")
        duration = _finite_number(segment.get("duration"), label + " duration")

        if start < 0 or end <= start or duration <= 0:
            errors.append(segment_id + " 的时间范围或时长无效")
        calculated_duration = end - start
        if abs(calculated_duration - duration) > tolerance:
            errors.append(segment_id + " 的 end-start 与 duration 不一致")
        if index == 0 and abs(start) > tolerance:
            errors.append("第一段必须从 0 秒开始")
        if index > 0:
            delta = start - previous_end
            if delta > tolerance:
                errors.append(segment_id + " 与上一段之间存在时间空隙")
            elif delta < -tolerance:
                errors.append(segment_id + " 与上一段时间重叠或倒退")
        if duration - max_segment_duration > tolerance:
            errors.append(segment_id + " 超过单段时长上限")
        if duration < 1:
            warnings.append(segment_id + " 时长不足 1 秒，检查是否可自然执行")

        normalized.append({
            "id": segment_id,
            "start": start,
            "end": end,
            "duration": duration,
        })
        duration_sum += duration
        previous_end = end

    if abs(duration_sum - total_duration) > tolerance:
        errors.append("所有分段 duration 之和不等于 totalDuration")
    if abs(previous_end - total_duration) > tolerance:
        errors.append("最后一段 end 不等于 totalDuration")

    valid = len(errors) == 0
    return {
        "valid": valid,
        "readyToDeliver": valid,
        "totalDuration": total_duration,
        "segmentCount": len(segments),
        "durationSum": duration_sum,
        "segments": normalized,
        "errors": errors,
        "warnings": warnings,
    }
