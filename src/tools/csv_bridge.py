"""Bounded, quoted-CSV-aware reads; no model-provided code execution."""
import csv
import json
import sys

request = json.load(sys.stdin)
filters = request.get('where', {})
columns = request.get('columns')
limit = request.get('limit', 20)
offset = request.get('offset', 0)
if not isinstance(filters, dict) or len(filters) > 20 or not all(isinstance(k, str) and isinstance(v, str) for k, v in filters.items()):
    raise ValueError('where must map column names to exact strings')
if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 100000:
    raise ValueError('Invalid bounds')
with open(request['path'], newline='', encoding='utf-8-sig') as handle:
    reader = csv.DictReader(handle)
    headers = reader.fieldnames or []
    if not set(filters) <= set(headers): raise ValueError('Unknown filter column')
    if columns is not None and (not isinstance(columns, list) or not all(isinstance(k, str) and k in headers for k in columns)):
        raise ValueError('Unknown output column')
    rows = []
    matched = 0
    truncated = False
    for record in reader:
        if not all(record.get(k) == v for k,v in filters.items()): continue
        matched += 1
        if matched <= offset: continue
        if len(rows) >= limit:
            truncated = True
            break
        rows.append({k: record.get(k) for k in (columns or headers)})
    print(json.dumps({'headers': headers, 'rows': rows, 'offset': offset, 'truncated': truncated}, ensure_ascii=False))
