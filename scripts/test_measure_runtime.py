"""Exercise CPU accounting with process exit/reuse, without real app data."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which('pwsh'), 'PowerShell 7 is required for runtime measurement')
class RuntimeMeasurementTests(unittest.TestCase):
    def delta(self, previous, current, tick=200):
        # All generated values are fixed test data, not shell-interpolated user input.
        path = str(Path(__file__).with_name('measure-runtime.ps1')).replace("'", "''")
        code = (f". '{path}' -FunctionsOnly; "
                f"$prior = '{json.dumps(previous)}' | ConvertFrom-Json -AsHashtable; "
                f"$samples = '{json.dumps(current)}' | ConvertFrom-Json; "
                f"Get-CpuSampleDelta $prior @($samples) {tick} | ConvertTo-Json -Compress")
        result = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', code],
                                check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_exiting_child_does_not_subtract_its_prior_cpu(self):
        result = self.delta({'1:100': 2, '2:120': 7},
                            [{'Identity': '1:100', 'CpuSeconds': 3, 'StartedUtcTicks': 100}])
        self.assertEqual(result['DeltaCpuSeconds'], 1)
        self.assertEqual(result['Current'], {'1:100': 3})

    def test_reused_pid_counts_new_process_without_negative_delta(self):
        result = self.delta({'2:120': 7},
                            [{'Identity': '2:250', 'CpuSeconds': .5, 'StartedUtcTicks': 250}])
        self.assertEqual(result['DeltaCpuSeconds'], .5)

    def test_newly_discovered_old_process_does_not_count_pre_sample_cpu(self):
        result = self.delta({}, [{'Identity': '3:100', 'CpuSeconds': 8, 'StartedUtcTicks': 100}])
        self.assertEqual(result['DeltaCpuSeconds'], 0)


if __name__ == '__main__':
    unittest.main()
