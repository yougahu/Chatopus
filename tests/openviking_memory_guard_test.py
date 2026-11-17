"""Source attribution regressions; no services or model calls are used."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("boe_memory_guard", ROOT / "scripts/openviking-memory-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
A = "member_" + "a" * 40
B = "member_" + "b" * 40


def message(text, peer=A, role="user", source="qq:1:2:3", id="original"):
    return NS(id=id, parts=[NS(text=text)], peer_id=peer, role=role,
              source_message_ids=[source], created_at="2026-11-08T07:00:00Z")


class SourceGuardTest(unittest.TestCase):
    def test_source_owns_destination_body_and_provenance(self):
        source = message("以后请叫我阿青，回答尽量简洁。")
        result = guard.verified_fact({"content": source.parts[0].text, "ranges": "0"},
                                    "preferences", [source], [source], {})
        uri, fields = result
        self.assertTrue(uri.startswith(f"viking://user/group/peers/{A}/memories/preferences/fact_"))
        self.assertEqual(fields["content"], source.parts[0].text)
        proof = fields["boe_provenance"]
        self.assertEqual(proof["peer_id"], A)
        self.assertEqual(proof["source_message_ids"], ["qq:1:2:3"])
        self.assertEqual(proof["content_sha256"], hashlib.sha256(fields["content"].encode()).hexdigest())
        self.assertEqual(proof["source_created_at"], source.created_at)
        self.assertIn("extracted_at", proof)

    def test_rejects_other_members_assistant_assumptions_and_missing_sources(self):
        source = message("我要整理项目文档帮我选目录结构")
        assistant = message("按常规采用两层标题并按日期排序", role="assistant", id="reply")
        cases = [
            ({"content": source.parts[0].text, "ranges": "0", "peer_id": B}, [source]),
            ({"content": source.parts[0].text, "ranges": "0", "user": B}, [source]),
            ({"content": "偏好两层标题和按日期排序", "ranges": "0"}, [source]),
            ({"content": assistant.parts[0].text, "ranges": "1"}, [source, assistant]),
            ({"content": source.parts[0].text, "ranges": "0-1"}, [source, assistant]),
            ({"content": source.parts[0].text, "ranges": "999999"}, [source]),
        ]
        for fields, sources in cases:
            with self.subTest(fields=fields):
                self.assertIsNone(guard.verified_fact(fields, "preferences", sources, sources, {}))
        source.source_message_ids = []
        self.assertIsNone(guard.verified_fact({"content": source.parts[0].text, "ranges": "0"},
                                            "profile", [source], [source], {}))

    def test_partial_quote_cannot_remove_negation_or_later_correction(self):
        source = message("我以前喜欢长篇解释，现在不喜欢长篇解释了。")
        result = guard.verified_fact({"content": "喜欢长篇解释", "ranges": "0"},
                                     "preferences", [source], [source], {})
        self.assertEqual(result[1]["content"], source.parts[0].text)
        self.assertEqual(result[1]["boe_provenance"]["quote"], source.parts[0].text)
        source.parts[0].text = "我喜欢长篇解释。" + "补充上下文" * 500
        self.assertIsNone(guard.verified_fact({"content": "我喜欢长篇解释", "ranges": "0"},
                                            "preferences", [source], [source], {}))

    def test_chunk_resolves_to_original_source_identity(self):
        source = message("这段介绍很长。我是一名软件工程师。平时会研究文档规范。")
        chunk = message("我是一名软件工程师。", id="original#chunk_1")
        chunk.source_message_ids = None
        result = guard.verified_fact({"content": chunk.parts[0].text, "ranges": "0"}, "profile",
                                     [chunk], [source], {id(chunk): NS(source_message_id=source.id)})
        self.assertEqual(result[1]["boe_provenance"]["source_message_ids"], ["qq:1:2:3"])

    def test_replay_uses_same_uri_and_new_statement_has_separate_record(self):
        source = message("我喜欢简短回答，也喜欢详细示例。")
        first = guard.verified_fact({"content": "我喜欢简短回答", "ranges": "0"}, "preferences", [source], [source], {})
        repeat = guard.verified_fact({"content": "我喜欢简短回答", "ranges": "0"}, "preferences", [source], [source], {})
        changed = guard.verified_fact({"content": source.parts[0].text, "ranges": "0"}, "preferences", [source], [source], {})
        self.assertEqual(first[0], repeat[0])
        self.assertEqual(first[0], changed[0])
        self.assertEqual(first[1]["content"], source.parts[0].text)


class NativeIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec("openviking") is None:
            raise unittest.SkipTest("Use the pinned OpenViking venv for native integration")
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        path = Path(cls.temp.name) / "ov.conf"
        path.write_text(json.dumps({"storage": {"workspace": cls.temp.name}, "memory": {
            "custom_templates_dir": str(ROOT / "scripts/openviking-memory-templates")}}))
        os.environ["OPENVIKING_CONFIG_FILE"] = str(path)
        guard.install()

    def loop(self, sources, allowed=None):
        from openviking.message import Message
        from openviking.message.part import TextPart
        from openviking.server.identity import RequestContext, Role
        from openviking_cli.session.user_id import UserIdentifier
        from openviking.session.memory.extract_loop import ExtractLoop
        from openviking.session.memory.memory_isolation_handler import MemoryIsolationHandler
        from openviking.session.memory.session_extract_context_provider import SessionExtractContextProvider
        from openviking.session.memory.memory_type_registry import MemoryTypeRegistry
        registry = MemoryTypeRegistry(load_schemas=False)
        registry.load_from_directory(str(ROOT / "scripts/openviking-memory-templates"))
        ctx = RequestContext(user=UserIdentifier("boe_guard_test", "group"), role=Role.USER)
        messages = [Message(id=m.id, role=m.role, peer_id=m.peer_id, parts=[TextPart(m.parts[0].text)],
                            created_at=m.created_at, source_message_ids=m.source_message_ids) for m in sources]
        provider = SessionExtractContextProvider(messages, ctx=ctx, memory_registry=registry)
        context = provider.get_extract_context()
        isolation = MemoryIsolationHandler(ctx, context, allowed_memory_types=guard.TYPES,
                                           allow_self=False, allowed_peer_ids=allowed or {A, B})
        provider._isolation_handler = isolation
        loop = ExtractLoop(vlm=NS(model="no-model"), viking_fs=NS(), ctx=ctx,
                           context_provider=provider, isolation_handler=isolation)
        loop._extract_context = context
        from openviking.session.memory.schema_model_generator import SchemaModelGenerator
        loop._operations_model = SchemaModelGenerator(registry.list_all()).create_structured_operations_model(isolation.get_read_scope())
        return loop, registry

    def test_native_resolution_ignores_wrong_model_owner_and_keeps_native_policy(self):
        source = message("以后请叫我阿青，回答尽量简洁。")
        loop, registry = self.loop([source, message("普通闲聊而已", B, source="qq:1:2:4", id="b")])
        raw = loop._operations_model.model_validate({"preferences": [{"page_id": 1, "peer_id": B, "ranges": "0", "content": source.parts[0].text}]})
        resolved, links = asyncio.run(loop.resolve_operations(raw))
        op = resolved.upsert_operations[0]
        self.assertIn("/peers/" + A + "/", op.uris[0])
        self.assertEqual(op.memory_fields["boe_provenance"]["peer_id"], A)
        self.assertEqual(links, [])
        blocked, _ = self.loop([source], allowed={B})
        result, _ = asyncio.run(blocked.resolve_operations(raw))
        self.assertEqual(result.upsert_operations[0].uris, [])

    def test_incompatible_account_templates_fail_closed(self):
        loop, registry = self.loop([message("我喜欢简洁的回答")])
        registry.get("preferences").content_template = "Inferred preference: {{ content }}"
        with self.assertRaisesRegex(RuntimeError, "deployment memory templates"):
            loop.context_provider.get_memory_schemas(loop.ctx)

    def test_native_serialization_preserves_quote_and_provenance(self):
        from openviking.session.memory.utils.memory_file_utils import MemoryFileUtils
        source = message("我喜欢简洁的回答")
        loop, _ = self.loop([source])
        raw = loop._operations_model.model_validate({"preferences": [{"page_id": 1, "ranges": "0", "content": source.parts[0].text}]})
        result, _ = asyncio.run(loop.resolve_operations(raw))
        op = result.upsert_operations[0]
        from openviking.session.memory.utils.memory_file_utils import _serialize_with_metadata
        body = _serialize_with_metadata(dict(op.memory_fields), source_uri=op.uris[0])
        stored = MemoryFileUtils.read(body, uri=op.uris[0])
        self.assertEqual(stored.plain_content().strip(), source.parts[0].text)
        self.assertEqual(stored.extra_fields["boe_provenance"]["peer_id"], A)


if __name__ == "__main__":
    unittest.main()
