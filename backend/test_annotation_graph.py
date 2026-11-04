"""Graph API regression tests, using isolated FileStorage only."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
try:
    from backend import test_api_integration as api_tests
except ModuleNotFoundError:
    import test_api_integration as api_tests
from annotation_graph import canonical_graph, internal_graph, publication_copy, validate_graph
import prepare_publication


def graph_fixture():
    return {
        "case_id": "graph", "id": "graph", "type": "self", "annotation_schema_version": 3, "annotation_editor_version": 2,
        "parties": [{"party_id": "P1", "id": "P1", "name": "Corrected person", "procedural_role": "DEFENDANT"}],
        "notes": "Case note", "legal_provisions": [{"content": "Law metadata"}],
        "requests": [{"request_id": "R1", "span": {"text": "  Request\n", "start": 9}, "asserted_by": ["P1"], "status": "PARTIALLY_WITHDRAWN",
                      "modification_spans": [{"text": "withdraw part", "start": 15}], "premise_ids": ["PR1"], "opinion_ids": ["O1"], "annotation_status": "confirmed"},
                     {"request_id": "R2", "span": {"text": "Another request"}, "asserted_by": ["P1"], "status": "ACTIVE", "premise_ids": ["PR1"], "opinion_ids": ["O1"]}],
        "opinions": [{"opinion_id": "O1", "span": {"text": "Opinion"}, "asserted_by": ["P1"], "premise_ids": ["PR1"]}],
        "premises": [{"premise_id": "PR1", "span": {"text": "Shared premise"}, "asserted_by": ["P1"]},
                     {"premise_id": "PR2", "span": {"text": "Unused but retained"}, "asserted_by": ["P1"]}],
        "reasonings": [{"reasoning_id": "RE1", "span": {"text": "Court reasoning", "start": 50}}],
        "decisions": [{"decision_id": "DE1", "span": {"text": "Court decision"}}],
        "request_reasoning_links": [{"request_id": "R1", "reasoning_id": "RE1", "vote_count": 4, "vote_sources": ["source"]}],
        "request_decision_links": [{"request_id": "R1", "decision_id": "DE1", "vote_count": 3}],
        "request_outcomes": [{"request_id": "R1", "outcome": "DISCONTINUED", "vote_agreement": "yes", "vote_detail": {"x": 1}}],
    }


class GraphApiTests(unittest.TestCase):
    def setUp(self):
        self.fixture = api_tests.ApiIntegrationTests()
        self.fixture.setUp()
        self.client = self.fixture.client
        self.auth = self.fixture._auth(self.fixture.admin_token)

    def tearDown(self):
        self.fixture.tearDown()

    def test_admin_and_annotator_roundtrip_export_and_expert_isolation(self):
        source = graph_fixture()
        source["type"] = "expert"
        self.fixture._import_cases(source)
        ann = self.fixture._create_annotator()
        self.fixture._assign("graph", ann["id"])
        ann_auth = self.fixture._auth(self.fixture._login_annotator())
        blank = self.client.get('/api/cases/graph/doc', headers=ann_auth).json()
        for field in ('requests', 'opinions', 'premises', 'units', 'reasonings', 'decisions', 'legacy_units', 'request_decision_links'):
            self.assertEqual(blank[field], [])
        for auth in (self.auth, ann_auth):
            with self.subTest(role=auth == self.auth):
                payload = graph_fixture()
                payload['_editor_state'] = {'tab': 'requests', 'picker': {'parentId': 'O1', 'type': 'premise', 'creating': True, 'form': {'text': 'unfinished'}}}
                response = self.client.put('/api/cases/graph/draft', json=payload, headers=auth)
                self.assertEqual(response.status_code, 200, response.text)
                draft = self.client.get('/api/cases/graph/draft', headers=auth).json()
                for key in ('requests', 'opinions', 'premises', 'notes', 'parties', '_editor_state', 'request_decision_links'):
                    self.assertEqual(draft[key], payload[key])
                payload.pop('_editor_state')
                response = self.client.post('/api/submit', json=payload, headers=auth)
                self.assertEqual(response.status_code, 200, response.text)
                saved = self.client.get('/api/cases/graph/submission', headers=auth).json()
                self.assertEqual(saved['requests'], payload['requests'])
        export = self.client.get('/api/export/submissions', headers=self.auth).json()['submissions']
        self.assertEqual(len(export), 2)
        for saved in export:
            self.assertNotIn('units', saved)
            self.assertNotIn('_editor_state', saved)
            self.assertEqual(len(saved['premises']), 2)
            self.assertEqual(saved['requests'][0]['span'], source['requests'][0]['span'])
            self.assertEqual(saved['requests'][0]['status'], 'PARTIALLY_WITHDRAWN')
            for key in ('notes', 'parties', 'request_decision_links', 'request_reasoning_links', 'request_outcomes', 'legal_provisions'):
                self.assertEqual(saved[key], source[key])
        csv = self.client.get('/api/export/submissions.csv', headers=self.auth)
        self.assertEqual(csv.status_code, 200)
        self.assertIn('Case note', csv.text)
        self.assertIn('discontinued', csv.text)

    def test_invalid_graph_rejected_atomically_and_draft_classification_allowed(self):
        self.fixture._import_cases(graph_fixture())
        for mutate in (
            lambda d: d['requests'][0]['premise_ids'].append('missing'),
            lambda d: d['opinions'][0]['premise_ids'].append('missing'),
            lambda d: d['requests'][0]['opinion_ids'].append('missing'),
            lambda d: d['premises'][0]['asserted_by'].append('missing'),
            lambda d: d['request_decision_links'][0].update(decision_id='missing'),
            lambda d: d['request_outcomes'][0].update(outcome='INVALID'),
            lambda d: d['requests'][0].update(status='confirmed'),
            lambda d: d['premises'].append(deepcopy(d['premises'][0])),
        ):
            doc = graph_fixture()
            mutate(doc)
            response = self.client.post('/api/submit', headers=self.auth, json=doc)
            self.assertEqual(response.status_code, 400, response.text)
        doc = graph_fixture()
        doc['legacy_units'] = [{'id': 'C1', 'type': 'claim', 'text': 'unclassified'}]
        self.assertEqual(self.client.put('/api/cases/graph/draft', json=doc, headers=self.auth).status_code, 200)
        self.assertEqual(self.client.post('/api/submit', json=doc, headers=self.auth).status_code, 400)
        self.assertEqual(self.client.get('/api/export/submissions', headers=self.auth).json()['count'], 0)
        self.assertEqual(self.client.put('/api/cases/graph/draft', json={'annotation_editor_version': 2, 'units': []}, headers=self.auth).status_code, 409)

    def test_import_validation_before_any_write(self):
        valid = graph_fixture()
        bad = graph_fixture()
        bad['case_id'] = bad['id'] = 'bad'
        bad['requests'][0]['opinion_ids'] = ['missing']
        response = self.client.post('/api/cases', headers=self.auth, json={'cases': [valid, bad]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get('/api/cases/graph/source', headers=self.auth).status_code, 404)

    def test_v3_import_ignores_stale_internal_mirrors(self):
        doc = graph_fixture()
        doc['units'] = [{'id': 'C99', 'type': 'claim', 'text': 'stale copy'}]
        doc['reasoning'] = []
        self.fixture._import_cases(doc)
        source = self.client.get('/api/cases/graph/source', headers=self.auth).json()
        self.assertEqual(len(source['units']), 5)
        self.assertEqual(source['reasoning'][0]['id'], 'RE1')
        self.assertNotIn('C99', [u['id'] for u in source['units']])

    def test_old_client_cannot_overwrite_v3_work_on_legacy_source(self):
        self.fixture._import_cases({'id': 'graph', 'type': 'expert', 'units': []})
        new = graph_fixture()
        old = {'case_id': 'graph', 'annotation_editor_version': 2, 'units': []}
        self.assertEqual(self.client.put('/api/cases/graph/draft', json=new, headers=self.auth).status_code, 200)
        self.assertEqual(self.client.post('/api/submit', json=old, headers=self.auth).status_code, 409)
        self.assertEqual(self.client.post('/api/submit', json=new, headers=self.auth).status_code, 200)
        self.assertEqual(self.client.put('/api/cases/graph/draft', json=old, headers=self.auth).status_code, 409)
        self.assertEqual(self.client.post('/api/submit', json=old, headers=self.auth).status_code, 409)

    def test_self_outcomes_recovered_from_old_import_without_overwriting_drafts(self):
        values = ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'DISCONTINUED']
        source = {'id': 'old-outcomes', 'case_id': 'old-outcomes', 'type': 'self',
                  'parties': [{'id': 'P1', 'name': 'Person'}],
                  'units': [{'id': str(i), 'type': 'request', 'text': f'Request {i}', 'assertedBy': ['P1'], 'outcome': None} for i in range(4)],
                  'request_outcomes': [{'request_id': str(i), 'outcome': value} for i, value in enumerate(values)]}
        self.fixture._import_cases(source)
        # Simulate documents that were normalized and persisted by the old importer.
        api_tests.main.storage.save_case_doc('old-outcomes', source)
        ann = self.fixture._create_annotator()
        self.fixture._assign('old-outcomes', ann['id'])
        ann_auth = self.fixture._auth(self.fixture._login_annotator())
        for auth in (self.auth, ann_auth):
            loaded = self.client.get('/api/cases/old-outcomes/doc', headers=auth).json()
            self.assertEqual([u['outcome'] for u in loaded['units']], ['accepted', 'partial', 'rejected', 'discontinued'])
            draft = {**deepcopy(source), 'annotation_editor_version': 2}
            draft['units'][0]['outcome'] = 'rejected'
            response = self.client.put('/api/cases/old-outcomes/draft', headers=auth, json=draft)
            self.assertEqual(response.status_code, 200, response.text)
            saved = self.client.get('/api/cases/old-outcomes/draft', headers=auth).json()
            self.assertEqual(saved['units'][0]['outcome'], 'rejected')
            self.assertIsNone(saved['units'][1]['outcome'])
        self.assertIsNone(api_tests.main.storage.get_case_doc('old-outcomes')['units'][1]['outcome'])
        self.client.put('/api/annotation-settings', headers=self.auth, json={'show_suggestions': False})
        blank = self.client.get('/api/cases/old-outcomes/doc', headers=ann_auth).json()
        self.assertEqual(blank['units'], [])
        self.assertEqual(blank['request_outcomes'], [])
        self.fixture._import_cases({**source, 'id': 'expert-outcomes', 'case_id': 'expert-outcomes', 'type': 'expert'})
        self.assertEqual(self.client.get('/api/cases/expert-outcomes/doc', headers=self.auth).json()['units'], [])


class GraphSchemaTests(unittest.TestCase):
    def test_roundtrip_and_publication_copy_do_not_mutate_annotations(self):
        source = graph_fixture()
        original = deepcopy(source)
        result = canonical_graph(internal_graph(source))
        validate_graph(result, complete=True)
        self.assertEqual(result['request_decision_links'], source['request_decision_links'])
        self.assertEqual(result['request_outcomes'], source['request_outcomes'])
        self.assertEqual(result['premises'][0]['span'], source['premises'][0]['span'])
        published = publication_copy(source)
        self.assertEqual(len(published['premises']), 1)
        self.assertEqual(source, original)
        self.assertEqual(len(result['premises']), 2)

    def test_publication_command_keeps_input_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / 'original.json', Path(tmp) / 'publication.json'
            original = json.dumps({'submissions': [graph_fixture()]}, ensure_ascii=False)
            source.write_text(original, encoding='utf-8')
            args = ['prepare_publication', '--input', str(source), '--output', str(target), '--confirm-annotation-complete']
            with patch('sys.argv', args):
                prepare_publication.main()
                with self.assertRaises(FileExistsError):
                    prepare_publication.main()
            self.assertEqual(source.read_text(encoding='utf-8'), original)
            self.assertEqual(len(json.loads(target.read_text())['submissions'][0]['premises']), 1)


if __name__ == '__main__':
    unittest.main()
