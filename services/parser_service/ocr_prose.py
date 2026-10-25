"""Conservative punctuation reconciliation for text without native PDF evidence."""
import re


SENTENCE_PUNCTUATION = frozenset('.,;:!?，。；：！？、')
NUMERIC_PUNCTUATION = frozenset('.,:，．：')


def _cjk(char):
    return '\u3400' <= char <= '\u9fff' or '\uf900' <= char <= '\ufaff'


def _latin(char):
    return char.isascii() and char.isalpha()


def _content_and_gaps(text):
    positions = [i for i, char in enumerate(text) if not char.isspace()]
    protected = []
    for j, i in enumerate(positions):
        char = text[i]
        following_digit = j < len(positions) - 1 and text[positions[j + 1]].isdigit()
        numeric = following_digit and (char in '.．' or char in NUMERIC_PUNCTUATION and j > 0 and text[positions[j - 1]].isdigit())
        if char not in SENTENCE_PUNCTUATION or numeric:
            protected.append(i)
    content = ''.join(text[i] for i in protected)
    gaps = [text[:protected[0]]] if protected else [text]
    gaps.extend(text[left + 1:right] for left, right in zip(protected, protected[1:]))
    if protected:
        gaps.append(text[protected[-1] + 1:])
    return content, gaps


def reconcile_ocr_prose(primary, secondary):
    """Use secondary punctuation only when protected content and word boundaries agree."""
    candidate = '\n\n'.join(text.strip() for text in secondary if text.strip())
    audit = {'accepted': False, 'changed': False, 'reason': None, 'basis': 'ocr-agreement', 'evidence_basis': 'ocr-agreement', 'status': 'unresolved', 'native_confirmed': False, 'before': primary, 'after': primary, 'secondary_content': candidate}

    def rejected(reason):
        audit['reason'] = reason
        return primary, audit

    if not primary.strip() or not candidate:
        return rejected('ocr_prose_comparison_unavailable')
    if any(re.search(r'[$\\<>^_]|\*\*|~~', text) for text in (primary, candidate)):
        return rejected('ocr_prose_markup_requires_preservation')
    content, original_gaps = _content_and_gaps(primary)
    other_content, other_gaps = _content_and_gaps(candidate)
    if not content or content != other_content:
        return rejected('ocr_prose_protected_content_disagreement')

    gaps = list(original_gaps)
    for i, (before, after) in enumerate(zip(original_gaps, other_gaps)):
        if before == after:
            continue
        left, right = content[i - 1] if i else '', content[i] if i < len(content) else ''
        punctuated = any(char in SENTENCE_PUNCTUATION for char in before + after)
        if left and right:
            if left.isdigit() and right.isdigit() or (left in NUMERIC_PUNCTUATION and right.isdigit()) or (left.isdigit() and right in NUMERIC_PUNCTUATION):
                return rejected('ocr_prose_numeric_spacing_disagreement')
            if _latin(left) and _latin(right):
                if not before or not after or not any(char.isspace() for char in before + after):
                    return rejected('ocr_prose_latin_word_boundary_disagreement')
                if not punctuated:
                    if bool(before.strip()) or bool(after.strip()):
                        return rejected('ocr_prose_latin_word_boundary_disagreement')
                    if ('\n' in before or '\n' in after) and before.isspace() and after.isspace():
                        gaps[i] = after
                    continue
            elif not punctuated and not (_cjk(left) or _cjk(right)):
                if bool(before) != bool(after):
                    return rejected('ocr_prose_word_boundary_disagreement')
                continue
        if punctuated or left and right and (_cjk(left) or _cjk(right)):
            gaps[i] = after

    result = gaps[0] + ''.join(char + gaps[i + 1] for i, char in enumerate(content))
    audit.update(accepted=True, changed=result != primary, reason='ocr_prose_punctuation_spacing_reconciled' if result != primary else 'ocr_prose_content_agrees', after=result)
    return result, audit
