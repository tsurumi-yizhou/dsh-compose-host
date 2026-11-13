import json
import re
import unittest
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1] / 'bundles/dsh-compose-app'

class Bundle(unittest.TestCase):
    def test_patch_retains_host_roster(self):
        patch = (BUNDLE / 'cordis.patch.yml').read_text()
        self.assertNotRegex(patch, r'name:.*(?:client-ui-|frontend-static|dsh-web-app)')
        ids = set(re.findall(r'^\s*- id: (\S+)', patch, re.M))
        self.assertTrue({'modules', 'connection', 'webserver', 'web-runtime', 'web-startup',
                         'api-remotes', 'session-controller', 'settings-controller',
                         'plugin-inventory', 'schedule', 'agent-preset-registry'} <= ids)

    def test_all_patch_package_references_are_declared(self):
        manifest = json.loads((BUNDLE / 'package.json').read_text())
        for name in manifest['dsh']['bundle']['patch']:
            for module in re.findall(r'^\s*name:\s*[\'\"]?([^\s\'\"]+)', (BUNDLE / name).read_text(), re.M):
                # Loader's intrinsic group and package self-exports are not dependencies.
                if module == 'cordis:group':
                    continue
                package = '/'.join(module.split('/')[:2]) if module.startswith('@') else module.split('/')[0]
                if package == manifest['name']:
                    export = '.' + module[len(package):]
                    self.assertIn(export, manifest['exports'])
                else:
                    self.assertIn(package, manifest['dependencies'], module)


if __name__ == '__main__':
    unittest.main()
