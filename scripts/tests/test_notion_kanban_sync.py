import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch


SCRIPT = pathlib.Path(__file__).parents[1] / 'notion_kanban_sync.py'
SPEC = importlib.util.spec_from_file_location('notion_kanban_sync', SCRIPT)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class NotionWorkflowAuthorityTest(unittest.TestCase):
    def paired(self, local_state='verify', notion_state='RUNNING'):
        local = {'id': 'c1', 'title': 'Title', 'priority': 'normal', 'assignee': '', 'description': '',
                 'status': 'testing', 'workflow_state': local_state, 'state': local_state}
        page = {'page_id': 'p1', 'localid': 'c1', 'archived': False, 'title': 'Title',
                'priority': 'normal', 'assignee': '', 'description': '', 'workflow_state': notion_state}
        return local, page

    def test_state_divergence_is_repaired_outbound_and_never_written_locally(self):
        local, page = self.paired()
        with patch.object(sync, 'local_cards', return_value=[local]), \
             patch.object(sync, 'notion_pages', return_value=[page]), \
             patch.object(sync, 'load_state', return_value={}), \
             patch.object(sync, 'save_state'), \
             patch.object(sync, 'local_update') as local_update, \
             patch.object(sync, 'notion_update_state') as update_state:
            sync.main()
        local_update.assert_not_called()
        update_state.assert_called_with('p1', 'verify')

    def test_notion_content_edit_sends_only_content_fields_to_generic_put(self):
        local, page = self.paired(local_state='running', notion_state='RUNNING')
        page['title'] = 'Edited in Notion'
        previous = sync._sig({**local, 'title': 'Title'})
        with patch.object(sync, 'local_cards', return_value=[local]), \
             patch.object(sync, 'notion_pages', return_value=[page]), \
             patch.object(sync, 'load_state', return_value={'c1': previous}), \
             patch.object(sync, 'save_state'), \
             patch.object(sync, 'dash_headers', return_value={}), \
             patch.object(sync, '_req') as request:
            sync.main()
        put_bodies = [c.kwargs['body'] for c in request.call_args_list if c.kwargs.get('method') == 'PUT']
        self.assertEqual(put_bodies, [{'title': 'Edited in Notion', 'priority': 'normal', 'assignee': '', 'description': ''}])
        self.assertNotIn('status', put_bodies[0])
        self.assertNotIn('state', put_bodies[0])

    def test_canonical_state_property_uses_uppercase_notion_options(self):
        props = sync._props({'id': 'c1', 'title': 'x', 'state': 'repair'})
        self.assertEqual(props['Status'], {'select': {'name': 'REPAIR'}})

    def test_unknown_notion_state_is_quarantined_and_overwritten_from_local(self):
        local, page = self.paired(local_state='blocked', notion_state='MYSTERY')
        with patch.object(sync, 'local_cards', return_value=[local]), \
             patch.object(sync, 'notion_pages', return_value=[page]), \
             patch.object(sync, 'load_state', return_value={}), \
             patch.object(sync, 'save_state'), \
             patch.object(sync, 'local_update') as local_update, \
             patch.object(sync, 'notion_update_state') as update_state:
            sync.main()
        local_update.assert_not_called()
        update_state.assert_called_once_with('p1', 'blocked')

    def test_failed_outbound_state_patch_does_not_advance_sync_baseline(self):
        local, page = self.paired()
        with patch.object(sync, 'local_cards', return_value=[local]), \
             patch.object(sync, 'notion_pages', return_value=[page]), \
             patch.object(sync, 'load_state', return_value={}), \
             patch.object(sync, 'save_state') as save, \
             patch.object(sync, 'local_update'), \
             patch.object(sync, 'notion_update_state', side_effect=RuntimeError('network')):
            with self.assertRaises(RuntimeError):
                sync.main()
        save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
