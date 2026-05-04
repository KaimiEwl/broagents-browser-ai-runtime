function normalizeText(text) {
  return String(text || "").replace(/\r/g, "").trim();
}

function includesAny(text, variants) {
  return variants.some((variant) => text.includes(variant));
}

function validateReply(reply, spec = {}) {
  const normalized = normalizeText(reply);

  if (!normalized) {
    return "EMPTY_REPLY";
  }

  if (spec.startsWith && !normalized.startsWith(spec.startsWith)) {
    return `BAD_PREFIX_${spec.startsWith}`;
  }

  if (spec.minLength && normalized.length < spec.minLength) {
    return `TOO_SHORT_${spec.minLength}`;
  }

  if (Array.isArray(spec.requiredGroups)) {
    for (const group of spec.requiredGroups) {
      if (!Array.isArray(group) || group.length === 0) {
        continue;
      }

      if (!includesAny(normalized, group)) {
        return `MISSING_SECTION_${group[0]}`;
      }
    }
  }

  if (spec.minParagraphs) {
    const paragraphs = normalized
      .split(/\n\s*\n/g)
      .map((item) => item.trim())
      .filter(Boolean);

    if (paragraphs.length < spec.minParagraphs) {
      return `TOO_FEW_PARAGRAPHS_${spec.minParagraphs}`;
    }
  }

  if (spec.maxLength && normalized.length > spec.maxLength) {
    return `TOO_LONG_${spec.maxLength}`;
  }

  if (spec.rejectBrokenText !== false) {
    if (/\?{5,}/.test(normalized)) {
      return "BROKEN_ENCODING_QUESTION_MARKS";
    }

    if (/[ÐÑ]{2,}/.test(normalized)) {
      return "BROKEN_ENCODING_MOJIBAKE";
    }
  }

  return null;
}

function assertValidReply(reply, spec = {}, label = "REPLY") {
  const error = validateReply(reply, spec);

  if (error) {
    throw new Error(`${label}_${error}`);
  }

  return reply;
}

module.exports = {
  assertValidReply,
  validateReply
};
