"""Exercise delegated startup with stock Linux Herdr and Pi, with a loopback-only model."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = Path(__file__).resolve().parents[1]
TASK = 'Implement synthetic W123: delegate one fixture writer, then acknowledge.'
WRITER_TASK = 'Run the synthetic writer fixture; reply without tools.'
ANSWER = 'Native smoke acknowledgement.'


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = request['messages']
        writer = WRITER_TASK in json.dumps(messages[-1])
        last = messages[-1]
        tool = None
        if last['role'] == 'user' and self.server.task in json.dumps(last):
            tool = ('continuation_spawn', dict(key='native-writer', task=WRITER_TASK, role='writer'))
        elif last['role'] == 'tool' and last.get('tool_call_id') == 'fixture-continuation_spawn':
            try:
                worker = json.loads(last['content'])['workerId']
            except (ValueError, KeyError, TypeError):
                self.send_error(400, 'Unexpected fixture spawn result')
                return
            tool = ('continuation_owner_wait', dict(kind='child', children=[worker]))
        # Keep the writer working while the owner settles; keep the existing
        # pre-response assertion of the exact owner startup receipt as well.
        gate = (self.server.allow_recovery if 'Recovery fixture task' in json.dumps(last) else
                self.server.allow_writer if writer else self.server.allow_response)
        if not gate.wait(55):
            self.send_error(504)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        if tool:
            name, arguments = tool
            call = dict(index=0, id=f'fixture-{name}', type='function',
                        function=dict(name=name, arguments=json.dumps(arguments)))
            response = [({'role': 'assistant', 'tool_calls': [call]}, None), ({}, 'tool_calls')]
        else:
            response = [({'role': 'assistant'}, None), ({'content': ANSWER}, None), ({}, 'stop')]
        for delta, stop in response:
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


def capture_sidebar(herdr, work, env, resize, evidence):
    # A real native client on a 132x42 PTY; retain the original ANSI streams.
    # Restarting the client for each width makes each stream replayable alone.
    for width in (42, 24):
        resize(width)
        pid, terminal = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execve(herdr, [herdr], env)
        try:
            fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 132, 0, 0))
            end = time.monotonic() + 2
            with (evidence/f'agents-{width}.ansi').open('wb') as capture:
                while time.monotonic() < end:
                    if not select.select([terminal], [], [], 0.1)[0]:
                        continue
                    data = os.read(terminal, 262144)
                    capture.write(data)
                    for query, reply in ((b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?1;2c'),
                                         (b'\x1b[>0c', b'\x1b[>0;1;0c')):
                        if query in data:
                            os.write(terminal, reply)
        finally:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.close(terminal)
            finally:
                os.waitpid(pid, 0)


def run(root, model, package, baseline, evidence, nested, checkpoint_recovery):
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
    target = work/'risk-analytics' if nested else work
    if nested:
        target.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=target, env=env, check=True)
    model.task = TASK + (' in risk-analytics.' if nested else '')
    (profile/'settings.json').write_text(json.dumps(dict(packages=[str(package)], defaultProvider='fixture',
                                                       defaultModel='fixture', defaultThinkingLevel='off')))
    (profile/'models.json').write_text(json.dumps({'providers': {'fixture': {
        'baseUrl': f'http://127.0.0.1:{model.server_port}/v1', 'api': 'openai-completions',
        'apiKey': 'fixture-not-secret', 'models': [{'id': 'fixture', 'name': 'Fixture',
            'reasoning': False, 'input': ['text'], 'contextWindow': 8192, 'maxTokens': 1024,
            'cost': dict(input=0, output=0, cacheRead=0, cacheWrite=0)}]}}}))
    bash = shutil.which('bash')
    if not bash:
        raise RuntimeError('Native check requires Bash on PATH')
    (home/'.bashrc').write_text('if [ -n "$PI_CONTINUATION_SPAWN" ]; then\n'
                               '  sleep 3 && printf "%s\\n" "$PI_CONTINUATION_SPAWN" > "$HOME/slow-shell-ready"\n'
                               'fi\n')
    def write_config(width):
        (config/'config.toml').write_text('''onboarding = false
[terminal]
default_shell = %s
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
[session]
resume_agents_on_restore = false
[ui]
sidebar_width = %d
sidebar_min_width = %d
sidebar_max_width = %d
[ui.sound]
enabled = false
[ui.sidebar.agents]
row_gap = 1
rows = [["state_icon", "state_text", "workspace"], ["agent"], ["$pi_continuation"]]
''' % (json.dumps(bash), width, width, width))
    write_config(42)
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
            def shell_alone(pane):
                info = cli('pane', 'process-info', '--pane', pane)['process_info']
                shell = info.get('shell_pid')
                processes = info.get('foreground_processes', [])
                return (shell and info.get('foreground_process_group_id') == shell and len(processes) == 1
                        and processes[0]['pid'] == shell and processes[0]['name'] == 'bash')

            for name, pane in [('smoke-supervisor', supervisor), ('smoke-planner', planner)]:
                until(f'{name} shell available', lambda: shell_alone(pane))
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
            cli('agent', 'prompt', planner, f'/start-implementation {model.task}')

            def dispatched(role):
                for f in state_dir.glob('spawn-????????-????-????-????-????????????.json'):
                    attempt = json.loads(f.read_text())
                    if attempt['role'] != role:
                        continue
                    if attempt['status'] == 'held':
                        raise AssertionError(attempt['failure'])
                    if attempt['status'] == 'dispatched':
                        return attempt
            attempt = until('owner assignment dispatched', lambda: dispatched('owner'), 50)
            panes.append(attempt['paneId'])
            assert (home/'slow-shell-ready').read_text().strip() == attempt['id']
            state = json.loads(state_path.read_text())
            assert list(state['workers']) == [attempt['workerId']], state['workers']
            owner = state['workers'][attempt['workerId']]
            assert owner['role'] == 'owner' and owner['paneId'] == attempt['paneId']
            assert owner['cwd'] == str(target) and attempt['child']['cwd'] == str(target), owner
            assert cli('agent', 'get', planner)['agent']['cwd'] == str(work)
            assert owner['sessionId'] == attempt['child']['sessionId'] and not owner['paused'], owner
            receipt = json.loads((state_dir/f"spawn-receipt-{attempt['id']}.json").read_text())
            assert receipt['status'] == 'sent', receipt
            model.allow_response.set()
            writer_attempt = until('writer assignment dispatched', lambda: dispatched('writer'), 40)
            writer = writer_attempt['paneId']
            panes.append(writer)
            writer_binding = json.loads(state_path.read_text())['workers'][writer_attempt['workerId']]
            assert writer_binding['paneId'] == writer and writer_binding['sessionId'] == writer_attempt['child']['sessionId']
            assert writer_binding['cwd'] == str(target) and writer_attempt['child']['cwd'] == str(target)
            assert writer_binding['recipient']['sessionId'] == owner['sessionId'] and not writer_binding['paused']
            receipt = json.loads((state_dir/f"spawn-receipt-{writer_attempt['id']}.json").read_text())
            assert receipt['status'] == 'sent', receipt
            until('Pi model response', lambda: ANSWER in Path(owner['sessionFile']).read_text())
            observation_path = state_dir/f"observation-{attempt['workerId']}.json"
            until('owner turn settled', lambda: json.loads(observation_path.read_text())['outcome'] == 'completed')
            settled_owner = json.loads(state_path.read_text())['workers'][attempt['workerId']]
            assert not settled_owner['paused'], settled_owner
            assert json.loads(state_path.read_text())['ownerWaits'][owner['workerId']] == {
                'kind': 'child', 'children': [writer_attempt['workerId']]}, settled_owner
            turns = [json.loads(line) for line in Path(owner['sessionFile']).read_text().splitlines()]
            users = [turn for turn in turns if turn.get('message', {}).get('role') == 'user']
            assert len(users) == 1 and model.task in json.dumps(users[0]), users
            def displayed(pane, activity, role):
                agent = cli('agent', 'get', pane)['agent']
                info = cli('pane', 'get', pane)['pane']
                assert agent['name'].startswith('pc-'), agent
                if (agent['agent_status'] not in activity or info.get('tokens', {}).get('pi_continuation') != 'Supervised'
                        or info.get('display_agent') != role or info.get('label') != role):
                    return None
                return dict(activity=agent['agent_status'], name=agent['name'], label=info.get('label'),
                            display_agent=info.get('display_agent'), supervision=info['tokens']['pi_continuation'])

            cli('agent', 'focus', owner['paneId'])
            labels = (None, None) if baseline else ('Owner · W123', 'Writer · W123')
            seen = dict(owner=until('idle owner presentation',
                                    lambda: displayed(owner['paneId'], ('idle',), labels[0])),
                        writer=until('working writer presentation', lambda: displayed(writer, ('working',), labels[1])))
            print(json.dumps(seen, ensure_ascii=False), flush=True)
            if evidence:
                def resize(width):
                    write_config(width)
                    cli('server', 'reload-config')
                capture_sidebar(herdr, work, env, resize, evidence)
                (evidence/'presentation.json').write_text(json.dumps(seen, ensure_ascii=False, indent=2))
            if not baseline and not checkpoint_recovery:
                manual_label = 'Manual owner label'
                cli('pane', 'rename', owner['paneId'], manual_label)
                renamed_at = time.monotonic()
                # The reporter's 15 s Herdr TTL bounds any pre-rename name.
                # Allow one extra second so a still-visible name requires a later report.
                ttl_seconds = 15
                time.sleep(ttl_seconds + 1)
                elapsed = time.monotonic() - renamed_at
                assert elapsed > ttl_seconds, elapsed
                info = cli('pane', 'get', owner['paneId'])['pane']
                assert info.get('label') == manual_label and info.get('display_agent') == labels[0], info
                renewal = dict(seconds_after_rename=round(elapsed, 3), ttl_seconds=ttl_seconds,
                               label=info['label'], display_agent=info['display_agent'])
                print('Post-rename metadata renewal: ' + json.dumps(renewal, ensure_ascii=False), flush=True)
                if evidence:
                    (evidence/'manual-rename-renewal.json').write_text(json.dumps(renewal, ensure_ascii=False, indent=2))
            if checkpoint_recovery:
                recovery_pane = cli('pane', 'split', planner, '--direction', 'down', '--cwd', str(work))['pane']['pane_id']
                panes.append(recovery_pane)
                until('recovery shell', lambda: shell_alone(recovery_pane))
                cli('agent', 'start', 'recovery-worker', '--kind', 'pi', '--pane', recovery_pane)
                cli('agent', 'prompt', recovery_pane, '/continuation-worker start')
                until('recovery worker confirmation', lambda: 'Start worker supervision?' in visible(recovery_pane))
                cli('agent', 'send-keys', recovery_pane, 'enter')
                def recovery_binding():
                    state = json.loads(state_path.read_text())
                    return next((binding for binding in state['workers'].values()
                                 if binding['paneId'] == recovery_pane), None)
                binding = until('managed recovery worker enrolled', recovery_binding)
                worker_id = binding['workerId']
                # Keep unrelated supervisor judgment out of this bounded recovery
                # probe. The independent global pause must survive the repair.
                cli('agent', 'prompt', supervisor, '/continuation-supervisor pause global')
                until('global pause confirmation', lambda: 'pause global?' in visible(supervisor))
                cli('agent', 'send-keys', supervisor, 'enter')
                until('global pause', lambda: json.loads(state_path.read_text())['paused'])
                observation_path = state_dir/f'observation-{worker_id}.json'
                cli('agent', 'prompt', recovery_pane, 'Recovery fixture task: report one sentence.')
                until('recovery worker running', lambda: observation_path.exists() and
                      json.loads(observation_path.read_text())['outcome'] == 'working')
                checkpoint = Path(binding['checkpoint'])
                checkpoint.unlink()
                checkpoint.mkdir()
                model.allow_recovery.set()
                def failed_report():
                    observation = json.loads(observation_path.read_text())
                    return observation if observation.get('checkpointRecovery') else None
                failed = until('held managed checkpoint write', failed_report)
                assert failed['hold'] and failed['holdError']['kind'] == 'checkpoint', failed
                checkpoint.rmdir()
                cli('agent', 'prompt', recovery_pane, '/reload')
                def restored():
                    observation = json.loads(observation_path.read_text())
                    current = json.loads(state_path.read_text())['workers'][worker_id]
                    return observation if (observation['outcome'] == 'completed' and not observation['hold'] and
                                           observation['stop'] == failed['checkpointRecovery']['report']['stop'] and
                                           not current['paused']) else None
                restored_report = until('same native stop automatically reassessed', restored, 25)
                assert restored_report['finalReply'] == ANSWER
                assert json.loads(state_path.read_text())['paused'], 'Global pause must survive recovery'
                assert ANSWER in checkpoint.read_text()
                print('Native checkpoint recovery passed: unchanged report, fresh checkpoint write, no Return/Clear hold')
            print('Native launch passed: slow Bash startup, exact owner/writer enrollment, and independent activity and display')
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
            model.allow_writer.set()
            model.allow_recovery.set()
            if server.poll() is None:
                try:
                    cli('server', 'stop')
                    server.wait(timeout=8)
                finally:
                    if server.poll() is None:
                        server.kill()
                        server.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=REPO, help='source package to load in disposable Pi')
    parser.add_argument('--baseline', action='store_true', help='expect no delegated display labels')
    parser.add_argument('--evidence', type=Path, help='directory for disposable native sidebar captures')
    parser.add_argument('--nested', action='store_true', help='launch owner and writer in a nested checkout')
    parser.add_argument('--checkpoint-recovery', action='store_true', help='exercise a managed write failure and native reload')
    args = parser.parse_args()
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pc-native-', dir='/tmp') as temp, \
            ThreadingHTTPServer(('127.0.0.1', 0), Model) as model:
        model.allow_response = threading.Event()
        model.allow_writer = threading.Event()
        model.allow_recovery = threading.Event()
        threading.Thread(target=model.serve_forever, daemon=True).start()
        try:
            run(Path(temp), model, args.package.resolve(), args.baseline, args.evidence,
                args.nested, args.checkpoint_recovery)
        finally:
            model.shutdown()
