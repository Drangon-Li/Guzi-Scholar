(function attachParagraphContinuation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuziParagraphContinuation = api;
}(typeof window === 'object' ? window : globalThis, function paragraphContinuation() {
  const terminal = /[.!?。！？;；:]\s*[\])}"'’”]*$/u;
  const lowercaseStart = /^[\s(["'‘“]*[a-z]/u;
  const auxiliaryPrefix = /^(?:(?:fig(?:ure)?|table|tab|scheme|plate|algorithm|references?|bibliography|footnotes?|notes?)\b|(?:\[\d+(?:\s*[,–-]\s*\d+)*\]|\d+[.)]|\([a-z0-9ivx]+\)|[a-z][.)]|[•*†‡])(?:\s|$))/iu;

  function validBox(box) {
    return Array.isArray(box) && box.length === 4 && box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      && box[0] < box[2] && box[1] < box[3];
  }

  function compatibleColumns(left, right) {
    const leftWidth = left[2] - left[0];
    const rightWidth = right[2] - right[0];
    const sameSingleColumn = leftWidth >= .55 && rightWidth >= .55
      && Math.abs(left[0] - right[0]) <= .035 && Math.abs(left[2] - right[2]) <= .08;
    // A complete reading order leaves the right column and resumes in the left.
    const nextDoubleColumn = leftWidth >= .20 && leftWidth <= .48 && rightWidth >= .20 && rightWidth <= .48
      && left[0] >= .48 && right[2] <= .52 && Math.abs(leftWidth - rightWidth) <= .10
      && Math.abs((1 - left[2]) - right[0]) <= .04;
    return sameSingleColumn || nextDoubleColumn;
  }

  function canJoin(previous, next) {
    if (!previous || !next || previous.tag !== 'p' || next.tag !== 'p' || previous.excluded || next.excluded) return false;
    if (!Number.isInteger(previous.page) || previous.page < 1 || next.page !== previous.page + 1) return false;
    if (previous.scope != null && next.scope != null && previous.scope !== next.scope) return false;
    if (!validBox(previous.bbox) || !validBox(next.bbox)) return false;
    if (previous.bbox[3] < .78 || next.bbox[1] > .20 || !compatibleColumns(previous.bbox, next.bbox)) return false;
    const left = typeof previous.text === 'string' ? previous.text.trim() : '';
    const right = typeof next.text === 'string' ? next.text.trim() : '';
    return Boolean(left && right && !terminal.test(left) && lowercaseStart.test(right)
      && !auxiliaryPrefix.test(left) && !auxiliaryPrefix.test(right));
  }

  return { canJoin };
}));
