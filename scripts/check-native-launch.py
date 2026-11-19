"""Exercise delegated startup with stock Linux Herdr and Pi, with a loopback-only model."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = Path(__file__).resolve().parents[1]
TASK = 'Native smoke fixture: reply with a short acknowledgement; do not use tools.'
ANSWER = 'Native smoke acknowledgement.'


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        self.rfile.read(int(self.headers['Content-Length']))
        # Check the launch/receipt boundary before settling the fixture turn.
        # This scenario does not cover a reply racing the dispatch commit.
        if not self.server.allow_response.wait(55):
            self.send_error(504)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, stop in [({'role': 'assistant'}, None), ({'content': ANSWER}, None), ({}, 'stop')]:
            chunk = dict(id='fixture', object='chat.completion.chunk', created=1, model='fixture',
                         choices=[dict(index=0, delta=delta, finish_reason=stop)])
            self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *_args):
        pass


def until(description, predicate, seconds=20):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f'Timed out: {description}')


def run(root, model):
    herdr = shutil.which('herdr')
    pi = shutil.which('pi')
    if not herdr or not pi:
        raise RuntimeError('Native check requires Herdr 0.9.5 and Pi 1.5.2 on PATH')
    home, work, config = root/'home', root/'work', root/'config/herdr'
    profile = home/'.pi/agent'
    for path in (work, config, profile, root/'runtime', root/'bin'):
        path.mkdir(parents=True, mode=0o700)
    # Keep the stock executable and restrict its model to our disposable profile.
    (root/'bin/pi').symlink_to(pi)
    env = dict(PATH=f"{root/'bin'}:{os.environ['PATH']}", HOME=str(home), USER='fixture',
               LOGNAME='fixture', SHELL='/bin/sh', TERM='xterm-256color', LANG='C.UTF-8',
               XDG_CONFIG_HOME=str(root/'config'), XDG_RUNTIME_DIR=str(root/'runtime'),
               XDG_DATA_HOME=str(root/'data'), XDG_CACHE_HOME=str(root/'cache'))
    def cli(*args):
        proc = subprocess.run([herdr, *args], cwd=work, env=env, text=True, capture_output=True, timeout=40)
        if proc.returncode:
            raise RuntimeError(f'{args}: {proc.stdout} {proc.stderr}')
        return json.loads(proc.stdout)['result'] if proc.stdout.strip().startswith('{') else None

    for binary, expected in ((herdr, '0.9.5'), (pi, '1.5.2')):
        version = subprocess.check_output([binary, '--version'], cwd=work, env=env, text=True).strip()
        if version.split()[-1] != expected:
            raise RuntimeError(f'Expected {expected} for {binary}; got {version}')
    subprocess.run(['git', 'init', '-q'], cwd=work, env=env, check=True)
    (profile/'settings.json').write_text(json.dumps(dict(packages=[str(REPO)], defaultProvider='fixture',
                                                       defaultModel='fixture', defaultThinkingLevel='off')))
    (profile/'models.json').write_text(json.dumps({'providers': {'fixture': {
        'baseUrl': f'http://127.0.0.1:{model.server_port}/v1', 'api': 'openai-completions',
        'apiKey': 'fixture-not-secret', 'models': [{'id': 'fixture', 'name': 'Fixture',
            'reasoning': False, 'input': ['text'], 'contextWindow': 8192, 'maxTokens': 1024,
            'cost': dict(input=0, output=0, cacheRead=0, cacheWrite=0)}]}}}))
    (config/'config.toml').write_text('''onboarding = false
[terminal]
default_shell = "/bin/sh"
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
[session]
resume_agents_on_restore = false
''')
    cli('integration', 'install', 'pi')
    with (root/'server.log').open('w+') as log:
        server = subprocess.Popen([herdr, 'server'], cwd=work, env=env, stdin=subprocess.DEVNULL,
                                  stdout=log, stderr=log)
        panes = []
        try:
            until('isolated server socket', lambda: (config/'herdr.sock').exists())
            ws = cli('workspace', 'create', '--label', 'Startup fixture', '--cwd', str(work))
            supervisor = ws['root_pane']['pane_id']
            planner = cli('pane', 'split', supervisor, '--direction', 'down', '--cwd', str(work))['pane']['pane_id']
            panes.extend([supervisor, planner])
            for name, pane in [('smoke-supervisor', supervisor), ('smoke-planner', planner)]:
                cli('agent', 'start', name, '--kind', 'pi', '--pane', pane)
            cli('agent', 'prompt', supervisor, '/continuation-supervisor start')
            def visible(pane):
                return subprocess.check_output([herdr, 'pane', 'read', pane, '--source', 'visible'],
                                               cwd=work, env=env, text=True, timeout=8)
            until('supervisor confirmation', lambda: 'Start continuation supervisor?' in visible(supervisor))
            cli('agent', 'send-keys', supervisor, 'enter')
            state_dir = home/'.pi-continuation'
            state_path = state_dir/'supervisor.json'
            until('active supervisor', lambda: state_path.exists() and json.loads(state_path.read_text())['acceptStarts'])
            cli('agent', 'prompt', planner, f'/start-implementation {TASK}')

            def dispatched():
                for f in state_dir.glob('spawn-????????-????-????-????-????????????.json'):
                    attempt = json.loads(f.read_text())
                    if attempt['status'] == 'held':
                        raise AssertionError(attempt['failure'])
                    if attempt['status'] == 'dispatched':
                        return attempt
            attempt = until('owner assignment dispatched', dispatched, 50)
            panes.append(attempt['paneId'])
            state = json.loads(state_path.read_text())
            assert list(state['workers']) == [attempt['workerId']], state['workers']
            owner = state['workers'][attempt['workerId']]
            assert owner['role'] == 'owner' and owner['paneId'] == attempt['paneId']
            assert owner['sessionId'] == attempt['child']['sessionId'] and not owner['paused'], owner
            receipt = json.loads((state_dir/f"spawn-receipt-{attempt['id']}.json").read_text())
            assert receipt['status'] == 'sent', receipt
            model.allow_response.set()
            until('Pi model response', lambda: ANSWER in Path(owner['sessionFile']).read_text())
            observation_path = state_dir/f"observation-{attempt['workerId']}.json"
            until('owner turn settled', lambda: json.loads(observation_path.read_text())['outcome'] == 'completed')
            settled_owner = json.loads(state_path.read_text())['workers'][attempt['workerId']]
            assert not settled_owner['paused'], settled_owner
            turns = [json.loads(line) for line in Path(owner['sessionFile']).read_text().splitlines()]
            users = [turn for turn in turns if turn.get('message', {}).get('role') == 'user']
            assert len(users) == 1 and TASK in json.dumps(users[0]), users
            print('Native launch passed: real pane + interactive Pi + exact owner enrollment + one assignment receipt')
        except Exception:
            for pane in panes:
                try:
                    print(f'{pane}: {visible(pane)}', flush=True)
                except Exception:
                    pass
            log.seek(0)
            print(log.read()[-4000:], flush=True)
            raise
        finally:
            model.allow_response.set()
            if server.poll() is None:
                try:
                    cli('server', 'stop')
                    server.wait(timeout=8)
                finally:
                    if server.poll() is None:
                        server.kill()
                        server.wait()


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='pc-native-', dir='/tmp') as temp, \
            ThreadingHTTPServer(('127.0.0.1', 0), Model) as model:
        model.allow_response = threading.Event()
        threading.Thread(target=model.serve_forever, daemon=True).start()
        try:
            run(Path(temp), model)
        finally:
            model.shutdown()
