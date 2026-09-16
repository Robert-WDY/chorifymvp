import unicodedata


TARGETS = {"zh", "en", "both", "either"}


def _normalize(value):
    return unicodedata.normalize("NFC", value or "")


def _contains(prompt_zh, prompt_en, text, target):
    needle = _normalize(text)
    zh = _normalize(prompt_zh)
    en = _normalize(prompt_en)
    if target == "zh":
        return needle in zh
    if target == "en":
        return needle in en
    if target == "both":
        return needle in zh and needle in en
    return needle in zh or needle in en


def _find_missing(prompt_zh, prompt_en, items):
    missing = []
    for item in items:
        text = item["text"]
        target = item.get("target", "either")
        if target not in TARGETS or not _contains(prompt_zh, prompt_en, text, target):
            missing.append({"text": text, "target": target})
    return missing


def _find_present(prompt_zh, prompt_en, items):
    present = []
    for item in items:
        text = item["text"]
        target = item.get("target", "either")
        if target in TARGETS and _contains(prompt_zh, prompt_en, text, target):
            present.append({"text": text, "target": target})
    return present


def _normalize_roles(roles):
    normalized = []
    for item in roles:
        normalized.append({
            "referenceId": item["referenceId"].strip(),
            "role": item["role"].strip(),
            "priority": item.get("priority", 50),
        })
    return sorted(normalized, key=lambda item: (item["priority"], item["referenceId"]))


def _duplicates(values):
    seen = set()
    duplicates = set()
    for value in values:
        key = _normalize(value).strip().casefold()
        if key in seen:
            duplicates.add(value)
        seen.add(key)
    return sorted(duplicates)


def main(input: dict):
    prompt_zh = input.get("promptZh", "")
    prompt_en = input.get("promptEn", "")
    exact_texts = input.get("exactTexts", [])
    must_keep = input.get("mustKeep", [])
    forbidden = input.get("forbiddenTexts", [])
    roles = _normalize_roles(input.get("referenceRoles", []))

    missing_exact = _find_missing(prompt_zh, prompt_en, exact_texts)
    missing_keep = _find_missing(prompt_zh, prompt_en, must_keep)
    found_forbidden = _find_present(prompt_zh, prompt_en, forbidden)
    duplicate_ids = _duplicates([item["referenceId"] for item in roles])
    duplicate_roles = _duplicates([item["role"] for item in roles])

    errors = []
    warnings = []
    if not prompt_zh.strip() and not prompt_en.strip():
        errors.append("promptZh 和 promptEn 不能同时为空")
    if missing_exact:
        errors.append("存在未逐字保留的精确文字")
    if missing_keep:
        errors.append("存在未保留的字面约束")
    if found_forbidden:
        errors.append("最终提示词包含禁止文字")
    if duplicate_ids:
        errors.append("同一参考图被重复声明")
    if duplicate_roles:
        warnings.append("多张参考图承担了相同主要职责，请确认是否会冲突")
    if prompt_zh.strip() and prompt_en.strip() and not exact_texts and not must_keep:
        warnings.append("脚本无法判断中英文语义是否一致，需要人工复核")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "checks": {
            "exactTextCount": len(exact_texts),
            "mustKeepCount": len(must_keep),
            "forbiddenTextCount": len(forbidden),
            "missingExactTexts": missing_exact,
            "missingMustKeep": missing_keep,
            "foundForbiddenTexts": found_forbidden,
            "duplicateReferenceIds": duplicate_ids,
            "duplicateRoles": duplicate_roles,
        },
        "normalizedReferenceRoles": roles,
    }

