import re
import unicodedata


HIGH_RISK_PHRASES = (
    "100%", "百分之百", "永久", "绝对", "第一", "销量第一",
    "官方认证", "立刻见效", "保证有效", "全网最低", "仅剩最后",
)


def _normalize(value):
    return unicodedata.normalize("NFC", value or "")


def _visible_length(value):
    return len(re.sub(r"\s+", "", _normalize(value)))


def _recommended_cover_range(platform):
    key = _normalize(platform).lower()
    if key in ("douyin", "抖音", "kuaishou", "快手"):
        return 4, 10
    if key in ("xiaohongshu", "小红书"):
        return 6, 12
    if key in ("bilibili", "b站", "bilibili/b站"):
        return 3, 8
    return 4, 12


def main(input: dict):
    platform = input.get("platform", "")
    valid_evidence = set(input.get("validEvidenceIds", []))
    forbidden_phrases = [_normalize(value) for value in input.get("forbiddenPhrases", [])]
    directions = input.get("directions", [])
    errors = []
    warnings = []
    summaries = []
    seen_cover_texts = set()
    low, high = _recommended_cover_range(platform)

    if not directions:
        errors.append("directions 不能为空")

    for item in directions:
        direction_id = item.get("id", "")
        cover_text = _normalize(item.get("coverText", ""))
        title = _normalize(item.get("title", ""))
        body = _normalize(item.get("body", ""))
        cta = _normalize(item.get("cta", ""))
        evidence_ids = item.get("evidenceIds", [])
        combined = "\n".join((cover_text, title, body, cta))

        if not evidence_ids:
            errors.append(direction_id + " 缺少证据 ID")
        unknown = sorted(set(evidence_ids) - valid_evidence)
        if unknown:
            errors.append(direction_id + " 引用了不存在的证据 ID：" + ", ".join(unknown))

        found_forbidden = [value for value in forbidden_phrases if value and value in combined]
        if found_forbidden:
            errors.append(direction_id + " 包含禁止短语：" + "、".join(found_forbidden))

        cover_key = cover_text.casefold()
        if cover_key in seen_cover_texts:
            warnings.append(direction_id + " 的封面主句与其他方向重复")
        seen_cover_texts.add(cover_key)

        cover_length = _visible_length(cover_text)
        if cover_length < low or cover_length > high:
            warnings.append(direction_id + " 的封面主句长度不在该平台建议范围内")

        high_risk = [value for value in HIGH_RISK_PHRASES if value in combined]
        if high_risk:
            warnings.append(direction_id + " 含高风险表达，请核对证据和限定条件：" + "、".join(high_risk))

        summaries.append({
            "id": direction_id,
            "coverTextLength": cover_length,
            "evidenceCount": len(evidence_ids),
            "unknownEvidenceIds": unknown,
            "foundForbiddenPhrases": found_forbidden,
            "highRiskPhrases": high_risk,
        })

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "summaries": summaries,
    }

