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

  function sameColumn(left, right) {
    const width = left[2] - left[0];
    const nextWidth = right[2] - right[0];
    return width >= .20 && nextWidth >= .20
      && Math.abs(left[0] - right[0]) <= .035 && Math.abs(left[2] - right[2]) <= .08
      && Math.abs(width - nextWidth) <= .10;
  }

  function fillsGap(images, start, end, column) {
    let cursor = start;
    for (const image of images) {
      const box = image.bbox;
      const overlap = Math.min(column[2], box[2]) - Math.max(column[0], box[0]);
      if (overlap < .5 * Math.min(column[2] - column[0], box[2] - box[0])
        || box[1] < cursor - .015 || box[1] - cursor > .12) return false;
      cursor = box[3];
    }
    return cursor <= end + .015 && end - cursor <= .12;
  }

  function canJoin(previous, next, { media = [] } = {}) {
    if (!previous || !next || previous.tag !== 'p' || next.tag !== 'p' || previous.excluded || next.excluded) return false;
    if (!Number.isInteger(previous.page) || previous.page < 1
      || (next.page !== previous.page && next.page !== previous.page + 1)) return false;
    if (previous.scope != null && next.scope != null && previous.scope !== next.scope) return false;
    if (!validBox(previous.bbox) || !validBox(next.bbox)) return false;
    if (!Array.isArray(media)) return false;
    if (!media.length) {
      if (next.page !== previous.page + 1 || previous.bbox[3] < .78 || next.bbox[1] > .20
        || !compatibleColumns(previous.bbox, next.bbox)) return false;
    } else {
      let page = previous.page;
      for (const image of media) {
        if (!image || image.tag !== 'figure' || image.excluded || !validBox(image.bbox)
          || !Number.isInteger(image.page) || image.page < page || image.page > next.page
          || (image.scope != null && ((previous.scope != null && image.scope !== previous.scope)
            || (next.scope != null && image.scope !== next.scope)))) return false;
        page = image.page;
      }
      if (previous.page === next.page) {
        if (!sameColumn(previous.bbox, next.bbox) || previous.bbox[3] > next.bbox[1]
          || !fillsGap(media, previous.bbox[3], next.bbox[1], previous.bbox)) return false;
      } else {
        if (!compatibleColumns(previous.bbox, next.bbox)) return false;
        const tail = media.filter((image) => image.page === previous.page);
        const head = media.filter((image) => image.page === next.page);
        if (tail.length) {
          const bottom = tail[tail.length - 1].bbox[3];
          if (bottom < .78 || !fillsGap(tail, previous.bbox[3], bottom, previous.bbox)) return false;
        } else if (previous.bbox[3] < .78) return false;
        if (head.length) {
          const top = head[0].bbox[1];
          if (top > .20 || !fillsGap(head, top, next.bbox[1], next.bbox)) return false;
        } else if (next.bbox[1] > .20) return false;
      }
    }
    const left = typeof previous.text === 'string' ? previous.text.trim() : '';
    const right = typeof next.text === 'string' ? next.text.trim() : '';
    return Boolean(left && right && !terminal.test(left) && lowercaseStart.test(right)
      && !auxiliaryPrefix.test(left) && !auxiliaryPrefix.test(right));
  }

  return { canJoin };
}));
