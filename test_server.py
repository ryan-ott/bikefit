import tempfile
import unittest
from pathlib import Path

import server


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DATA = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_session_roundtrip_and_copy(self):
        s = server.create_session("Before tweaks")
        s["measurements"]["saddle_height"] = 742
        server.write_json(server.session_dir(s["id"]) / "session.json", s)
        nxt = server.create_session("After", copy_from=s["id"])
        self.assertEqual(nxt["measurements"]["saddle_height"], 742)
        self.assertEqual({x["label"] for x in server.list_sessions()}, {"Before tweaks", "After"})

    def test_rejects_path_traversal(self):
        for bad in ["../etc", "a/b", "", "x" * 81]:
            with self.assertRaises(ValueError):
                server.session_dir(bad)
        self.assertIsNone(server.FILE_RE.match("../x.png"))
        self.assertIsNone(server.FILE_RE.match("x.sh"))

    def test_claude_cmd(self):
        self.assertNotIn("--resume", server.claude_cmd("hi", None))
        cmd = server.claude_cmd("hi", "abc")
        self.assertEqual(cmd[cmd.index("--resume") + 1], "abc")
        self.assertNotIn("Bash", cmd[cmd.index("--tools") + 1])


if __name__ == "__main__":
    unittest.main()
