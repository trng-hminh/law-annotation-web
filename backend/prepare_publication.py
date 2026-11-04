#!/usr/bin/env python3
"""Create a separate publication copy AFTER all annotation is complete.

Only unlinked premises are removed. Original files, database and court links
are never changed. This is not a prediction-input builder.
"""
import argparse
import json
from pathlib import Path
from annotation_graph import publication_copy, validate_graph


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--confirm-annotation-complete', action='store_true')
    args = parser.parse_args()
    if not args.confirm_annotation_complete:
        parser.error('Only run after the entire dataset has been annotated: --confirm-annotation-complete is required.')
    data = json.loads(args.input.read_text(encoding='utf-8-sig'))
    records = data if isinstance(data, list) else data.get('submissions', data.get('cases', []))
    if not isinstance(records, list) or not records:
        parser.error('Expected a nonempty case list or submissions/cases export.')
    for record in records:
        if record.get('annotation_schema_version') != 3:
            parser.error('Review and resubmit legacy records in the new editor first.')
        validate_graph(record, complete=True)
    cleaned = [publication_copy(record) for record in records]
    if isinstance(data, list):
        result = cleaned
    else:
        result = {**data, ('submissions' if 'submissions' in data else 'cases'): cleaned,
                  'postprocessing': 'unlinked premises removed from publication copy only'}
    # Exclusive creation prevents accidental replacement of the annotation source.
    with args.output.open('x', encoding='utf-8') as out:
        args.output.chmod(0o600)
        json.dump(result, out, ensure_ascii=False, indent=2)
    print(f'Wrote {len(cleaned)} records to {args.output}; originals unchanged.')


if __name__ == '__main__':
    main()
