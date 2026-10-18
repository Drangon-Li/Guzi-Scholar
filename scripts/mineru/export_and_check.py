import json
import sys
import zipfile
from pathlib import Path

from mineru.parser import ParseResult
from mineru.render import render_content_list, render_content_list_v2

archive, output, expected = sys.argv[1:]
output = Path(output)
output.mkdir()
with zipfile.ZipFile(archive) as zipped:
    zipped.extractall(output)
middles = list(output.rglob('middle_json.json'))
assert len(middles) == 1, f'Expected one middle_json.json: {middles}'
middle_path = middles[0]
payload = json.loads(middle_path.read_text(encoding='utf-8'))
assert payload['schema'] == 'docvortex.middle'
indices = [page['page_idx'] for page in payload['pages']]
assert indices == list(range(int(expected))), f'Incomplete/incorrect pages: {indices}'
assert payload.get('is_full_document', True), 'Parser reports partial document'
result = ParseResult.from_dict(payload)
content_v1 = render_content_list(result.middle_json)
content_v2 = render_content_list_v2(result.middle_json)
for name, data in [('content_list.json', content_v1), ('content_list_v2.json', content_v2)]:
    middle_path.with_name(name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
blocks = [block for page in payload['pages'] for block in page['blocks']]
summary = {
    'pages': len(indices), 'page_indices': indices,
    'producer': payload['metadata']['producer'],
    'mineru': payload.get('extensions', {}).get('mineru'),
    'blocks': len(blocks),
    'top_level_blocks_with_bbox': sum(block.get('bbox') is not None for block in blocks),
    'content_list_entries': len(content_v1),
    'content_list_entries_with_bbox': sum(item.get('bbox') is not None for item in content_v1),
    'middle_json': str(middle_path),
}
assert middle_path.with_name('markdown.md').is_file()
assert middle_path.with_name('structured_content.json').is_file()
output.joinpath('validation.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
