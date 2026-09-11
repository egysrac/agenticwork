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

    def test_archived_local_card_is_not_resurrected_from_a_stale_notion_page(self):
        # HERMES... no, unrelated incident: 2026-09-10 08:03, 8 cards Alex had
        # just archived locally came back as 8 brand-new cards. Root cause:
        # local_cards() excludes archived_at rows, so an archived card looks
        # identical to "never existed locally" to the Notion->Local loop --
        # UNLESS the sync remembers it (via `stored`) from a prior run. This
        # pins the archive-instead-of-resurrect branch for that known case.
        page = {'page_id': 'p1', 'localid': 'c1', 'archived': False, 'title': 'Title',
                'priority': 'normal', 'assignee': '', 'description': '', 'workflow_state': 'READY'}
        prior_sig = sync._sig({'title': 'Title', 'priority': 'normal', 'assignee': '', 'description': ''})
        with patch.object(sync, 'local_cards', return_value=[]), \
             patch.object(sync, 'notion_pages', return_value=[page]), \
             patch.object(sync, 'load_state', return_value={'c1': prior_sig}), \
             patch.object(sync, 'save_state') as save, \
             patch.object(sync, 'local_create') as local_create, \
             patch.object(sync, 'notion_archive') as notion_archive:
            sync.main()
        local_create.assert_not_called()
        notion_archive.assert_called_once_with('p1')
        saved_records = save.call_args.args[0]
        self.assertNotIn('c1', saved_records)

    def test_genuinely_new_notion_page_is_still_created_locally(self):
        # Fix-revert guard: a LocalID never seen before (not in `stored`) must
        # still take the normal "new card from Alex" path -- the fix must not
        # accidentally swallow real new-card creation.
        page = {'page_id': 'p1', 'localid': 'c1', 'archived': False, 'title': 'Title',
                'priority': 'normal', 'assignee': '', 'description': '', 'workflow_state': 'READY'}
        with patch.object(sync, 'local_cards', return_value=[]), \
             patch.object(sync, 'notion_pages', return_value=[page]), \
             patch.object(sync, 'load_state', return_value={}), \
             patch.object(sync, 'save_state'), \
             patch.object(sync, 'local_create', return_value=('new-id', 1)) as local_create, \
             patch.object(sync, 'notion_set_localid'), \
             patch.object(sync, 'notion_update_state'), \
             patch.object(sync, 'notion_archive') as notion_archive:
            sync.main()
        local_create.assert_called_once()
        notion_archive.assert_not_called()

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
