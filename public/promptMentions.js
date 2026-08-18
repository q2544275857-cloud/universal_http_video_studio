export function promptMentionContext(value, caretPosition = null) {
  const text = String(value ?? '');
  const caret = Number.isInteger(caretPosition) ? caretPosition : text.length;
  const before = text.slice(0, caret);
  const match = before.match(/(^|[\s，。,.!?；;：:\n])@([^\s，。,.!?；;：:\n@]*)$/);
  if (!match) return null;
  return {
    start: caret - match[2].length - 1,
    end: caret,
    query: match[2],
    queryLower: match[2].toLowerCase()
  };
}

export function applyPromptMention(value, context, alias) {
  const text = String(value ?? '');
  if (!context || !Number.isInteger(context.start) || !Number.isInteger(context.end)) {
    throw new Error('Invalid mention context.');
  }
  const insertion = `@${String(alias || '').trim()}`;
  const nextValue = `${text.slice(0, context.start)}${insertion}${text.slice(context.end)}`;
  return {
    value: nextValue,
    caret: context.start + insertion.length,
    insertion
  };
}
