"""SLO 巡检脚本的纯函数测试：不访问网络。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ops import slo


class SummarizeTests(unittest.TestCase):
    def test_summarize_full_payload(self):
        row = slo.summarize({
            "tasks": {"total": 146, "stale": [{"identifier": "HER-1"}], "awaiting": []},
            "blocked": {"count": 7, "onBoard": 3, "over24h": 4},
            "runs": {"total": 285, "recent": {"failed": 1, "timedOut": 5}},
            "alerts": [{"code": "board_gate"}],
        })
        self.assertEqual(row["tasks"], 146)
        self.assertEqual(row["blocked"], 7)
        self.assertEqual(row["blockedOnBoard"], 3)
        self.assertEqual(row["stale"], 1)
        self.assertEqual(row["timedOut24h"], 5)
        self.assertEqual(row["alerts"], ["board_gate"])

    def test_summarize_tolerates_missing_sections(self):
        row = slo.summarize({})
        self.assertEqual(row["tasks"], 0)
        self.assertEqual(row["blocked"], 0)
        self.assertEqual(row["alerts"], [])


if __name__ == "__main__":
    unittest.main()
