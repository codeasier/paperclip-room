import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.db'
        self.db = sqlite3.connect(self.path)
        self.db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT)')
        self.patch = patch.object(server, 'HERMES_DB', self.path)
        self.patch.start()
        self.run_meta = {'id': 'run-1', 'agentId': 'pl', 'sessionIdAfter': 'session-1'}
        self.add(1, 'user', self.prompt('run-1'))
        server._CACHE.clear()

    def tearDown(self):
        self.patch.stop()
        self.db.close()
        self.temp.cleanup()

    def prompt(self, rid, agent='pl', company=None):
        return f'Paperclip runtime identity:\n- Run ID: {rid}\n- Agent ID: {agent}\n- Company ID: {company or server.COMPANY}'

    def add(self, mid, role, text, calls=None, call_id=None, sid='session-1'):
        self.db.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)', (mid, sid, role, text, json.dumps(calls) if calls else None, call_id, 'terminal' if role=='tool' else None, 1792658920+mid, 'private-reasoning-never-display'))
        self.db.commit()

    def test_assistant_tools_and_no_prompts_or_reasoning(self):
        self.add(2, 'assistant', '正在检查', [{'id':'call-1','function':{'name':'terminal','arguments':'{"command":"git status"}'}}])
        self.add(3, 'tool', '{"output":"clean","exit_code":0}', call_id='call-1')
        self.add(4, 'assistant', '检查完成')
        data = server.session_transcript(self.run_meta)
        self.assertEqual(data['state'], 'available')
        self.assertEqual([e['kind'] for e in data['entries']], ['assistant','tool_call','tool_result','assistant'])
        self.assertEqual(data['entries'][1]['toolCallId'], data['entries'][2]['toolCallId'])
        self.assertFalse(data['entries'][2]['isError'])
        self.assertNotIn('private-reasoning', json.dumps(data))
        self.assertNotIn('runtime identity', json.dumps(data))

    def test_resumed_session_stops_at_next_wake(self):
        self.add(2, 'assistant', 'run one')
        self.add(3, 'user', self.prompt('run-2'))
        self.add(4, 'assistant', 'run two')
        first = server.session_transcript(self.run_meta)
        second = server.session_transcript({**self.run_meta,'id':'run-2'})
        self.assertEqual([e['text'] for e in first['entries']], ['run one'])
        self.assertEqual([e['text'] for e in second['entries']], ['run two'])

    def test_cross_agent_and_ambiguous_association_rejected(self):
        self.assertEqual(server.session_transcript({**self.run_meta,'agentId':'other'})['state'], 'pending')
        self.add(2, 'user', self.prompt('run-1'), sid='another')
        self.assertEqual(server.session_transcript(self.run_meta)['state'], 'unavailable')

    def test_session_mismatch_rejected(self):
        self.assertEqual(server.session_transcript({**self.run_meta,'sessionIdAfter':'wrong'})['state'], 'unavailable')

    def test_recent_page_then_earlier_no_duplicates(self):
        for mid in range(2,9):
            self.add(mid, 'assistant', f'output-{mid}')
        first = server.session_transcript(self.run_meta,page_size=3)
        second = server.session_transcript(self.run_meta,before=first['nextCursor'],page_size=3)
        third = server.session_transcript(self.run_meta,before=second['nextCursor'],page_size=3)
        self.assertEqual([e['id'] for e in first['entries']], ['m-6','m-7','m-8'])
        self.assertEqual([e['id'] for e in second['entries']], ['m-3','m-4','m-5'])
        self.assertEqual([e['id'] for e in third['entries']], ['m-2'])
        self.assertIsNone(third['nextCursor'])
        self.assertEqual(server.session_transcript(self.run_meta,before=1)['state'],'unavailable')

    def test_active_new_records_visible_without_finished_session(self):
        meta = {**self.run_meta,'sessionIdAfter':None,'status':'running'}
        self.assertEqual(server.session_transcript(meta)['entries'], [])
        self.add(2, 'assistant', '新进展')
        self.assertEqual(server.session_transcript(meta)['entries'][0]['text'], '新进展')

    def test_errors_clipping_and_credentials(self):
        self.add(2,'tool',json.dumps({'output':'Authorization: Bearer abcdefghijklmnopqrstuv '+'a'*18000,'exit_code':1}),call_id='t')
        entry = server.session_transcript(self.run_meta)['entries'][0]
        self.assertTrue(entry['isError'])
        self.assertTrue(entry['truncated'])
        self.assertNotIn('abcdefghijklmnopqrstuv', entry['text'])
        with patch.object(server,'api_key',return_value='automation-secret'):
            self.assertNotIn('automation-secret', server.public_text('automation-secret')['text'])

    def test_missing_db_explicit_fallback(self):
        with patch.object(server,'HERMES_DB',self.path.parent/'missing.db'):
            self.assertEqual(server.session_transcript(self.run_meta)['state'], 'unavailable')

    def test_run_company_id_drives_session_marker(self):
        self.add(5, 'user', self.prompt('run-x', company='other'))
        run = {**self.run_meta, 'id': 'run-x', 'companyId': 'other'}
        self.assertEqual(server.session_transcript(run)['state'], 'available')
        self.assertEqual(server.session_transcript({**self.run_meta, 'id': 'run-y'})['state'], 'pending')

    def test_api_limits_runs_and_does_not_mix_members(self):
        runs = [
            dict(self.run_meta, companyId=server.COMPANY, contextSnapshot={'issueId':'i1'}, resultJson={'result':'final'}),
            dict(self.run_meta, id='foreign', companyId=server.COMPANY, agentId='other', contextSnapshot={'issueId':'i1'}),
            dict(self.run_meta, id='chat-run', companyId=server.COMPANY, contextSnapshot={'issueId':'chat-1'}, resultJson={'result':'chat'}),
        ]
        issues = [{'id':'i1','identifier':'HER-1','title':'任务'}]
        with patch.object(server,'fetch_agents',return_value=[{'id':'pl'}]), patch.object(server,'call',return_value=(200,runs)), patch.object(server,'fetch_issues',return_value=issues):
            data=server.execution_timeline('pl')
        self.assertEqual([run['id'] for run in data['runs']], ['run-1'])
        self.assertEqual(data['runs'][0]['summary']['text'],'final')

    def test_member_window_is_bounded_scoped_and_shared_by_both_views(self):
        own = dict(self.run_meta, companyId='c1', contextSnapshot={'issueId':'i1'})
        runs = [own, dict(own, id='foreign-company', companyId='c2'),
                dict(own, id='foreign-agent', agentId='qa')]
        runs.extend(dict(own, id=f'run-{i}') for i in range(25))
        with patch.object(server, 'call', return_value=(200, {'runs':runs})) as api:
            first = server.fetch_agent_runs('pl', 'c1')
            self.assertTrue(first['available'])
            self.assertEqual(len(first['runs']), 18)
            self.assertTrue(all(r['companyId']=='c1' and r['agentId']=='pl' for r in first['runs']))
            self.assertEqual(server.fetch_agent_runs('pl', 'c1'), first)
            api.assert_called_once_with('GET', '/api/companies/c1/heartbeat-runs?agentId=pl&limit=20')
            second = server.fetch_agent_runs('pl', 'c2')
            self.assertEqual([r['id'] for r in second['runs']], ['foreign-company'])
            self.assertEqual(api.call_count, 2)

    def test_member_window_failure_is_not_reported_as_empty_history(self):
        for response in [(503, {}), (200, {'unexpected':[]})]:
            server._CACHE.clear()
            with patch.object(server, 'call', return_value=response):
                self.assertEqual(server.fetch_agent_runs('pl'), {'available':False, 'runs':[]})


if __name__ == '__main__':
    unittest.main()
