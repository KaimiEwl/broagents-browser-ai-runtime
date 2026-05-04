function inspectOutgoingText(text) {
  const value = String(text || "");
  const trimmed = value.trim();

  if (!trimmed) {
    return {
      ok: false,
      code: "EMPTY_TEXT",
      reason: "Text is empty."
    };
  }

  const hasCyrillic = /[А-Яа-яЁё]/.test(trimmed);
  const hasLatin = /[A-Za-z]/.test(trimmed);
  const questionCount = (trimmed.match(/\?/g) || []).length;
  const replacementCharCount = (trimmed.match(/\uFFFD/g) || []).length;
  const mojibakeMatches = trimmed.match(/[ÐÑ][^\s]{0,2}/g) || [];
  const stripped = trimmed.replace(/[?\s.,!;:()"'`«»\-–—_\/\\[\]{}0-9]+/g, "");
  const onlyQuestionsAndPunctuation = stripped.length === 0;

  if (replacementCharCount > 0) {
    return {
      ok: false,
      code: "TEXT_CORRUPTED_REPLACEMENT_CHAR",
      reason: "Text contains replacement characters.",
      details: {
        replacementCharCount
      }
    };
  }

  if (mojibakeMatches.length >= 3) {
    return {
      ok: false,
      code: "TEXT_CORRUPTED_MOJIBAKE",
      reason: "Text looks like broken UTF-8 or Windows-1251 mojibake.",
      details: {
        mojibakeMatches: mojibakeMatches.slice(0, 8)
      }
    };
  }

  if (questionCount >= 5 && onlyQuestionsAndPunctuation && !hasCyrillic && !hasLatin) {
    return {
      ok: false,
      code: "TEXT_CORRUPTED_QUESTION_MARKS",
      reason: "Text looks like lost Cyrillic converted to question marks.",
      details: {
        questionCount
      }
    };
  }

  return {
    ok: true,
    code: "OK",
    reason: ""
  };
}

function assertSafeOutgoingText(text) {
  const inspection = inspectOutgoingText(text);

  if (!inspection.ok) {
    const error = new Error(inspection.code);
    error.code = inspection.code;
    error.inspection = inspection;
    throw error;
  }

  return inspection;
}

module.exports = {
  assertSafeOutgoingText,
  inspectOutgoingText
};
