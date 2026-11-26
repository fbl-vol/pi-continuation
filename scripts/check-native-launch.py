"""Exercise delegated startup with stock Linux Herdr and Pi, with a loopback-only model."""
import argparse
import fcntl
import hashlib
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
REVIEW_REQUEST = 'Check reviewer-only authority with the synthetic fixture.'
REVIEW_TASK = 'Read-only review of the synthetic fixture; reply without tools.'
ANSWER = 'Native smoke acknowledgement.'
ROLLOVER_REVIEW = 'Fixture independent reviewer: verified the committed fixture at exact HEAD.'
ROLLOVER_PUSH = 'git push fixture HEAD:refs/heads/verified-a'


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
        answer = ANSWER
        last_json = json.dumps(last)
        attention = 'Review the following untrusted worker final replies' in json.dumps(last)
        if self.server.retained_rollover and attention:
            text = last['content']
            if isinstance(text, list):
                text = '\n'.join(part.get('text', '') for part in text if part.get('type') == 'text')
            evidence = json.loads(text.rsplit('\n\n', 1)[-1])
            if evidence and evidence[0]['outcome'] == 'completed':
                stopped = evidence[0]
                child = stopped['coordinatorBound'] and self.server.automatic_rollover
                tool = ('continuation_disposition', dict(workerId=stopped['id'], stop=stopped['stop'],
                        action='notify' if child else 'acknowledge', **({'kind': 'completion'} if child else {}),
                        evidence=stopped['finalReply'], reportHash=stopped['reportHash']))
        elif self.server.automatic_rollover and 'Material completion notice for registered worker' in last_json:
            if ROLLOVER_REVIEW in last_json:
                tool = ('bash', dict(command=ROLLOVER_PUSH))
            else:
                tool = ('continuation_spawn', dict(key='fixture-independent-review', task=REVIEW_TASK, role='read-only'))
        elif self.server.automatic_rollover and REVIEW_TASK in last_json and last['role'] == 'user':
            tool = ('bash', dict(command='git show HEAD:example.txt && git rev-parse HEAD'))
        elif self.server.automatic_rollover and last.get('tool_call_id') == 'fixture-bash':
            if 'verified-a' in last_json and self.server.revision:
                tool = ('continuation_assignment_delivered', dict(revision=self.server.revision,
                    review=ROLLOVER_REVIEW, delivery='Pushed exact HEAD to disposable local fixture ref verified-a; no PR owed.'))
            elif self.server.revision in last_json and 'reviewed fixture text' in last_json:
                answer = ROLLOVER_REVIEW
        elif not writer and not attention and last['role'] == 'user' and self.server.task in json.dumps(last):
            tool = ('continuation_spawn', dict(key='native-writer', task=WRITER_TASK, role='writer'))
        elif self.server.reviewer_recovery and last['role'] == 'user' and REVIEW_REQUEST in json.dumps(last):
            tool = ('continuation_spawn', dict(key='denied-writer', task='Synthetic second writer.', role='writer'))
        elif self.server.reviewer_recovery and last.get('tool_call_id') == 'fixture-denied-writer':
            tool = ('continuation_spawn', dict(key='recovered-review', task=REVIEW_TASK, role='read-only'))
        elif (self.server.reviewer_recovery and last.get('tool_call_id') == 'fixture-continuation_spawn' and
              WRITER_TASK in json.dumps(messages) and REVIEW_REQUEST not in json.dumps(messages)):
            tool = ('continuation_spawn', dict(key='preflight-writer', task='Synthetic refused preflight.', role='writer'))
        elif (not self.server.reviewer_recovery and not self.server.retained_rollover and last['role'] == 'tool' and
              last.get('tool_call_id') == 'fixture-continuation_spawn'):
            try:
                worker = json.loads(last['content'])['workerId']
            except (ValueError, KeyError, TypeError):
                self.send_error(400, 'Unexpected fixture spawn result')
                return
            wait = dict(kind='user') if self.server.owner_decision else dict(kind='child', children=[worker])
            if self.server.owner_chat:
                wait['findings'] = ['Correct the synthetic index.', 'Correct the synthetic label.']
            tool = ('continuation_owner_wait', wait)
        # Keep the writer working while the owner settles; keep the existing
        # pre-response assertion of the exact owner startup receipt as well.
        gate = (self.server.allow_recovery if (self.server.owner_decision and attention) or
                'Recovery fixture task' in json.dumps(last) else
                self.server.allow_writer if writer else self.server.allow_response)
        if not gate.wait(55):
            self.send_error(504)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        if tool:
            name, arguments = tool
            call_id = {'denied-writer': 'fixture-denied-writer', 'preflight-writer': 'fixture-preflight-writer'}.get(
                arguments.get('key'), f'fixture-{name}')
            call = dict(index=0, id=call_id, type='function',
                        function=dict(name=name, arguments=json.dumps(arguments)))
            response = [({'role': 'assistant', 'tool_calls': [call]}, None), ({}, 'tool_calls')]
        else:
            response = [({'role': 'assistant'}, None), ({'content': answer}, None), ({}, 'stop')]
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


def run(root, model, package, baseline, evidence, nested, checkpoint_recovery, preflight_recovery, new_space,
        worktree_choice, paused_supervisor, no_supervisor, restart_supervisor, delivery_preferences, reviewer_recovery,
        owner_decision, owner_decision_negative, owner_chat, planner_queue, parallel_assignment, retained_rollover,
        automatic_rollover, pi_version):
    model.reviewer_recovery = reviewer_recovery
    model.retained_rollover = retained_rollover or automatic_rollover
    model.automatic_rollover = automatic_rollover
    model.owner_chat = owner_chat
    model.owner_decision = owner_decision or owner_decision_negative or owner_chat
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

    for binary, expected in ((herdr, '0.9.5'), (pi, pi_version)):
        version = subprocess.check_output([binary, '--version'], cwd=work, env=env, text=True).strip()
        if version.split()[-1] != expected:
            raise RuntimeError(f'Expected {expected} for {binary}; got {version}')
    subprocess.run(['git', 'init', '-q'], cwd=work, env=env, check=True)
    target = work/'risk-analytics' if nested else work
    if nested:
        target.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=target, env=env, check=True)
    if automatic_rollover:
        (target/'example.txt').write_text('reviewed fixture text\n')
        subprocess.run(['git', 'add', 'example.txt'], cwd=target, env=env, check=True)
    if worktree_choice or parallel_assignment or automatic_rollover:
        subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                        'commit', '-q', '--allow-empty', '-m', 'Native fixture base'], cwd=target, env=env, check=True)
    if automatic_rollover:
        model.revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=target, env=env, text=True).strip()
        remote = root/'fixture.git'
        subprocess.run(['git', 'init', '--bare', '-q', remote], cwd=target, env=env, check=True)
        subprocess.run(['git', 'remote', 'add', 'fixture', remote], cwd=target, env=env, check=True)
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
            if not no_supervisor:
                cli('agent', 'prompt', supervisor, '/continuation-supervisor start')
            def visible(pane):
                return subprocess.check_output([herdr, 'pane', 'read', pane, '--source', 'visible'],
                                               cwd=work, env=env, text=True, timeout=8)
            state_dir = home/'.pi-continuation'
            state_path = state_dir/'supervisor.json'
            if no_supervisor:
                assert not state_path.exists()
            else:
                until('supervisor confirmation', lambda: 'Start continuation supervisor?' in visible(supervisor))
                cli('agent', 'send-keys', supervisor, 'enter')
                until('active supervisor', lambda: state_path.exists() and json.loads(state_path.read_text())['acceptStarts'])
            if delivery_preferences:
                cli('agent', 'prompt', planner, '/continuation')
                until('delivery menu entry', lambda: 'Delivery preferences' in visible(planner))
                cli('agent', 'send-keys', planner, 'enter')
                screen = until('delivery preferences view', lambda: visible(planner) if
                    'Push branch: Ask First' in visible(planner) else None)
                assert 'Start review: Automatic' in screen and 'Close review panes: Off' in screen
                if evidence: (evidence/'delivery-default-80.txt').write_text(screen)
                cli('agent', 'send-keys', planner, 'esc')
                assert not (state_dir/'delivery-preferences.json').exists()
                until('planner idle after preference cancel', lambda:
                    cli('agent', 'get', planner)['agent']['agent_status'] in ('idle', 'done'))
                cli('agent', 'prompt', planner, '/continuation')
                until('delivery menu reopened', lambda: 'Delivery preferences' in visible(planner))
                cli('agent', 'send-keys', planner, 'enter')
                until('default choices shown again', lambda: 'Push branch: Ask First' in visible(planner))
                cli('agent', 'send-keys', planner, 'down', 'down', 'enter')
                until('push preference choices', lambda: 'Push branch · Ask First' in visible(planner))
                cli('agent', 'send-keys', planner, 'enter')
                until('draft choice', lambda: 'Push branch: Automatic' in visible(planner))
                cli('agent', 'send-keys', planner, 'down', 'enter')
                until('fix preference choices', lambda: 'Fix review findings · Ask First' in visible(planner))
                cli('agent', 'send-keys', planner, 'enter')
                until('review-fix draft choice', lambda: 'Fix review findings: Automatic' in visible(planner))
                cli('agent', 'send-keys', planner, 'down', 'down', 'down', 'down', 'down', 'enter')
                def saved():
                    path = state_dir/'delivery-preferences.json'
                    if not path.exists(): return False
                    values = json.loads(path.read_text())['values']
                    return values['pushBranch'] == 'Automatic' and values['fixReviewFindings'] == 'Automatic'
                until('delivery preference saved', saved)
                # Native clients supply PTY dimensions; the fixture sidebar takes 42 columns.
                for width in (80, 40):
                    master, slave = pty.openpty()
                    fcntl.ioctl(master, termios.TIOCSWINSZ,
                                struct.pack('HHHH', 60, width + 42, 0, 0))
                    client = subprocess.Popen([herdr], cwd=work, env=env, stdin=slave,
                                              stdout=slave, stderr=slave, start_new_session=True,
                                              preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
                    os.close(slave)
                    try:
                        until(f'{width}-column pane', lambda:
                            cli('pane', 'layout', '--pane', planner)['layout']['area']['width'] == width)
                        if width == 80:
                            cli('pane', 'focus', '--pane', supervisor, '--direction', 'down')
                            until('planner idle after preference save', lambda:
                                cli('agent', 'get', planner)['agent']['agent_status'] in ('idle', 'done'))
                            cli('agent', 'prompt', planner, '/continuation')
                            until('delivery menu at 80 columns', lambda: '→ Delivery preferences' in visible(planner))
                            cli('agent', 'send-keys', planner, 'enter')
                        screen = until(f'saved choices at {width} columns', lambda: visible(planner) if
                            'Push branch: Automatic' in visible(planner) else None)
                        assert 'Close review panes: Off' in screen
                        assert 'Fix review findings: Automatic' in ' '.join(screen.split())
                        if evidence: (evidence/f'delivery-saved-{width}.txt').write_text(screen)
                        if width == 40: cli('agent', 'send-keys', planner, 'esc')
                    finally:
                        client.terminate()
                        try: client.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            client.kill()
                            client.wait(timeout=5)
                        os.close(master)
                print('Native delivery menu passed: defaults, Escape, Save and 80/40-column views', flush=True)
                return
            previous_supervisor = None
            if restart_supervisor:
                previous_supervisor = json.loads(state_path.read_text())['ownerToken']
                cli('agent', 'send-keys', supervisor, 'ctrl+d')
                until('graceful supervisor release', lambda: not (state_dir/'supervisor.lock').exists())
                retained = json.loads(state_path.read_text())
                retained['routes']['fixture-held-route'] = {'paused': True, 'reason': 'Independent test route pause'}
                state_path.write_text(json.dumps(retained) + '\n')
            if paused_supervisor:
                cli('agent', 'prompt', supervisor, '/continuation-supervisor pause global')
                until('global pause confirmation', lambda: 'pause global?' in visible(supervisor))
                cli('agent', 'send-keys', supervisor, 'enter')
                until('global pause persisted', lambda: json.loads(state_path.read_text())['paused'])
            placement = '--new-space -- ' if new_space else ''
            if worktree_choice:
                occupied = cli('pane', 'split', planner, '--direction', 'right', '--cwd', str(target))['pane']['pane_id']
                panes.append(occupied)
                until('occupied checkout shell', lambda: shell_alone(occupied))
                cli('agent', 'start', 'smoke-existing', '--kind', 'pi', '--pane', occupied)
                cli('agent', 'prompt', occupied, '/continuation-worker start')
                until('independent worker confirmation', lambda: 'Start worker supervision?' in visible(occupied))
                cli('agent', 'send-keys', occupied, 'enter')
                until('independent live writer', lambda: len(json.loads(state_path.read_text())['workers']) == 1)
                cli('agent', 'prompt', planner, f'/start-implementation Implement W123-D05 in {target}.')
                screen = until('one exact worktree selection', lambda: visible(planner) if
                    'Create in current space' in visible(planner) else None)
                assert 'Repository:' in screen and 'Base:' in screen and 'Branch:' in screen and 'Path:' in screen
                assert 'Create in new space' in screen and 'Cancel' in screen
                cli('agent', 'send-keys', planner, 'esc')
                until('cancelled worktree choice', lambda: 'Worktree choice cancelled' in visible(planner))
                assert len(json.loads(state_path.read_text())['workers']) == 1
                assert not list(state_dir.glob('spawn-????????-????-????-????-????????????.json'))
                print('Native worktree choice passed: one exact selector and no effects on cancel', flush=True)
                return
            if preflight_recovery:
                claim_path = state_dir/f'delegation-writer-{hashlib.sha256(str(target).encode()).hexdigest()}.json'
                claim_path.write_text(json.dumps({'id': '11111111-1111-4111-8111-111111111111'}))
                cli('agent', 'prompt', planner, f'/start-implementation {placement}{model.task}')
                def refused_attempt():
                    attempts = list(state_dir.glob('spawn-????????-????-????-????-????????????.json'))
                    if not attempts: return None
                    record = json.loads(attempts[0].read_text())
                    return record if record['status'] == 'preflight-refused' else None
                refused = until('proved no-split owner refusal', refused_attempt)
                assert len(json.loads(state_path.read_text())['workers']) == 0
                claim_path.unlink()
                until('planner idle after refusal', lambda: cli('agent', 'get', planner)['agent']['agent_status'] in ('idle', 'done'))
                cli('agent', 'prompt', planner, '/reload')
                until('planner reload completed', lambda: 'Reloaded keybindings' in visible(planner))
                until('planner idle after reload', lambda: cli('agent', 'get', planner)['agent']['agent_status'] in ('idle', 'done'))
            cli('agent', 'prompt', planner, f'/start-implementation {placement}{model.task}')

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
            if paused_supervisor:
                assert not json.loads(state_path.read_text())['paused']
                print('Native supervisor resume passed: one owner command, no second confirmation', flush=True)
            if no_supervisor or restart_supervisor:
                starts = list(state_dir.glob('supervisor-start-????????-????-????-????-????????????.json'))
                assert len(starts) == 1 and json.loads(starts[0].read_text())['status'] == 'ready'
                started = json.loads(starts[0].read_text())
                assert started['pane']['workspace_id'] != cli('agent', 'get', planner)['agent']['workspace_id']
                assert not (state_dir/'supervisor-start-pending.json').exists()
                if previous_supervisor:
                    state = json.loads(state_path.read_text())
                    assert state['ownerToken'] != previous_supervisor
                    assert state['routes']['fixture-held-route'] == {
                        'paused': True, 'reason': 'Independent test route pause'}
                panes.append(started['pane']['pane_id'])
                scenario = 'retained-state restart' if previous_supervisor else 'fresh bootstrap'
                print(f'Native supervisor {scenario} passed: dedicated space, one owner command', flush=True)
            if preflight_recovery:
                assert attempt['id'] == refused['id']
                assert len(list(state_dir.glob('spawn-????????-????-????-????-????????????.json'))) == 1
                print('Native preflight recovery passed: same scope/key after reload, one owner split', flush=True)
            panes.append(attempt['paneId'])
            assert (home/'slow-shell-ready').read_text().strip() == attempt['id']
            state = json.loads(state_path.read_text())
            assert list(state['workers']) == [attempt['workerId']], state['workers']
            owner = state['workers'][attempt['workerId']]
            assert owner['role'] == 'owner' and owner['paneId'] == attempt['paneId']
            assert owner['cwd'] == str(target) and attempt['child']['cwd'] == str(target), owner
            planner_info = cli('agent', 'get', planner)['agent']
            assert planner_info['cwd'] == str(work)
            if new_space:
                assert attempt['child']['workspaceId'] != planner_info['workspace_id']
                assert attempt['child']['workspaceId'] == owner['workspaceId']
                print('Native new-space owner passed: planner unchanged and target checkout preserved', flush=True)
            else:
                assert attempt['child']['workspaceId'] == planner_info['workspace_id']
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
            assert writer_binding['workspaceId'] == owner['workspaceId']
            assert writer_binding['recipient']['sessionId'] == owner['sessionId'] and not writer_binding['paused']
            receipt = json.loads((state_dir/f"spawn-receipt-{writer_attempt['id']}.json").read_text())
            assert receipt['status'] == 'sent', receipt
            until('Pi model response', lambda: ANSWER in Path(owner['sessionFile']).read_text())
            observation_path = state_dir/f"observation-{attempt['workerId']}.json"
            until('owner turn settled', lambda: json.loads(observation_path.read_text())['outcome'] == 'completed')
            settled_owner = json.loads(state_path.read_text())['workers'][attempt['workerId']]
            assert not settled_owner['paused'], settled_owner
            if planner_queue:
                before = json.loads(state_path.read_text())
                for position, scope in enumerate(['Update the documentation', 'Verify the example'], 1):
                    cli('agent', 'prompt', planner, f'Put {scope} after this assignment')
                    until(f'planner queue position {position}', lambda:
                          f'Queued in position {position}' in ' '.join(visible(planner).split()))
                after = json.loads(state_path.read_text())
                entries = after['assignmentQueues'][attempt['grantId']]
                assert [entry['scope'] for entry in entries] == ['Update the documentation', 'Verify the example']
                assert before['workers'] == after['workers']
                assert before['ownerWaits'] == after['ownerWaits']
                assert cli('agent', 'get', writer)['agent']['agent_status'] == 'working'
                print('Native planner queue passed: two ordered ordinary-chat entries, unchanged owner and writer', flush=True)
                return
            if parallel_assignment:
                alternative = root/'parallel-checkout'
                base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=target, env=env, text=True).strip()
                cli('agent', 'prompt', planner, f'Start {model.task} Parallel assignment separately')
                def separate_choice():
                    screen = visible(planner)
                    if 'Create in new space' not in screen or 'Queue after the current assignment' not in screen:
                        return None
                    return screen
                screen = until('one queue or separate-tree choice', separate_choice)
                path = next(line.split('Path:', 1)[1].strip() for line in screen.splitlines() if 'Path:' in line)
                alternative = Path(path)
                assert str(base) in ' '.join(screen.split())
                cli('agent', 'send-keys', planner, 'down', 'enter')
                def parallel_bindings():
                    current = json.loads(state_path.read_text())['workers']
                    bindings = [binding for binding in current.values() if binding['cwd'] == str(alternative)]
                    return bindings if len(bindings) == 2 else None
                second = until('parallel owner and writer enrolled', parallel_bindings, 50)
                second_owner, = (binding for binding in second if binding.get('role') == 'owner')
                second_writer, = (binding for binding in second if binding.get('recipient', {}).get('id') == second_owner['coordinatorId'])
                for binding in (second_owner, second_writer):
                    panes.append(binding['paneId'])
                    until('parallel task received', lambda: (state_dir/f"spawn-receipt-{binding['delegationId']}.json").exists() and
                          json.loads((state_dir/f"spawn-receipt-{binding['delegationId']}.json").read_text())['status'] == 'sent')
                assert second_owner['workspaceId'] == second_writer['workspaceId'] != owner['workspaceId']
                assert cli('agent', 'get', writer)['agent']['agent_status'] == 'working'
                until('parallel writer working', lambda:
                      cli('agent', 'get', second_writer['paneId'])['agent']['agent_status'] == 'working')
                final = json.loads(state_path.read_text())['workers']
                assert final[owner['workerId']] == settled_owner
                assert final[writer_attempt['workerId']] == writer_binding
                print('Native parallel chat passed: one explicit worktree choice, two isolated working writers, original owner unchanged', flush=True)
                return
            if retained_rollover or automatic_rollover:
                scope = 'B: verify the next example.'
                cli('agent', 'prompt', planner, f'Put {scope} after this assignment')
                until('queued B in planner', lambda: 'Queued in position 1' in ' '.join(visible(planner).split()))
                model.allow_writer.set()
                writer_obs = state_dir/f"observation-{writer_attempt['workerId']}.json"
                until('original writer settled', lambda: json.loads(writer_obs.read_text())['outcome'] == 'completed')
                until('original writer idle', lambda: cli('agent', 'get', writer)['agent']['agent_status'] in ('idle', 'done'))
                until('original owner idle', lambda: cli('agent', 'get', owner['paneId'])['agent']['agent_status'] in ('idle', 'done'))
                if not automatic_rollover:
                    cli('agent', 'prompt', planner,
                        f'/start-implementation --options {json.dumps(dict(closeAssignment=attempt["grantId"]))} -- {scope}')
                def retained_started():
                    screen = ' '.join(visible(planner).split())
                    if 'Extension "command:start-implementation" error:' in screen:
                        raise AssertionError((screen, json.loads(state_path.read_text()), cli('agent', 'list')))
                    if automatic_rollover:
                        current = json.loads(state_path.read_text())
                        return attempt['grantId'] in current['closedAssignments'] and not current['retainedAssignments']
                    return 'Queued assignment started in the existing owner and writer panes.' in screen
                until('retained start acknowledged', retained_started, 55)
                current = json.loads(state_path.read_text())
                assert attempt['grantId'] in current['closedAssignments']
                for prior in (settled_owner, writer_binding):
                    after, = (binding for binding in current['workers'].values() if binding['paneId'] == prior['paneId'])
                    assert after['workerId'] != prior['workerId']
                    assert after['sessionId'] == prior['sessionId'] and after['sessionFile'] == prior['sessionFile']
                    receipt = json.loads((state_dir/f"spawn-receipt-{after['delegationId']}.json").read_text())
                    assert receipt == {'id': after['delegationId'], 'status': 'sent'}
                    until('B appears in retained session journal', lambda: scope in Path(after['sessionFile']).read_text())
                    assert Path(after['sessionFile']).read_text().count('New approved assignment.') == 1
                if automatic_rollover:
                    outcome = current['assignmentOutcomes'][attempt['grantId']]
                    assert outcome['revision'] == model.revision and outcome['review'] == ROLLOVER_REVIEW
                    pushed = subprocess.check_output(['git', '--git-dir', remote, 'rev-parse', 'refs/heads/verified-a'],
                                                     env=env, text=True).strip()
                    assert pushed == model.revision
                    print('Native automatic rollover passed: queue, scripted independent review, local Git delivery, exact A outcome, and B once without another human command', flush=True)
                else:
                    print('Native retained assignment passed: closed A and delivered B once to both original sessions', flush=True)
                return
            if model.owner_decision:
                wait = json.loads(state_path.read_text())['ownerWaits'][owner['workerId']]
                assert wait['kind'] == 'user'
                cli('agent', 'prompt', owner['paneId'], 'Unrelated fixture question, not a decision.')
                until('unrelated turn settles', lambda: Path(owner['sessionFile']).read_text().count(ANSWER) == 2 and
                      json.loads(observation_path.read_text())['outcome'] == 'completed')
                assert json.loads(state_path.read_text())['ownerWaits'][owner['workerId']] == wait
                if owner_decision_negative:
                    cli('agent', 'prompt', supervisor, f"/continuation-supervisor pause worker {writer_attempt['workerId']}")
                    until('writer pause confirmation', lambda: 'pause worker?' in visible(supervisor))
                    cli('agent', 'send-keys', supervisor, 'enter')
                    until('writer independently paused', lambda: json.loads(state_path.read_text())['workers'][writer_attempt['workerId']]['paused'])
                model.allow_writer.set()
                writer_obs = state_dir/f"observation-{writer_attempt['workerId']}.json"
                until('existing writer settled', lambda: json.loads(writer_obs.read_text())['outcome'] == 'completed')
                until('exact writer idle', lambda: cli('agent', 'get', writer)['agent']['agent_status'] in ('idle', 'done'))
                writer_state = json.loads(state_path.read_text())['workers'][writer_attempt['workerId']]
                assert writer_state['paused'] == owner_decision_negative, writer_state
                if owner_chat:
                    cli('agent', 'prompt', owner['paneId'], 'fix the first only')
                    receipt_path = state_dir/f"receipt-{wait['id']}.json"
                    until('chat selection receipt', lambda: receipt_path.exists() and
                          json.loads(receipt_path.read_text())['status'] == 'sent')
                    session_file = Path(writer_binding['sessionFile'])
                    until('writer received the first finding', lambda: 'Correct the synthetic index.' in session_file.read_text())
                    assert 'Correct the synthetic label.' not in session_file.read_text()
                    until('owner waits for the existing writer', lambda: json.loads(state_path.read_text())['ownerWaits'].get(owner['workerId']) ==
                          {'kind': 'child', 'children': [writer_attempt['workerId']]})
                    print('Native owner chat passed: clarification kept the wait; one ordinary reply sent only finding 1', flush=True)
                    return
                cli('agent', 'prompt', owner['paneId'], '/continuation-owner decide')
                until('exact native owner decision prompt', lambda: 'Submit decision to the existing writer' in visible(owner['paneId']))
                decision = 'Fix synthetic F1 only; leave F2 unchanged.'
                cli('pane', 'send-text', owner['paneId'], decision)
                cli('pane', 'send-keys', owner['paneId'], 'enter')
                if owner_decision_negative:
                    until('paused writer refused', lambda: 'held, paused' in ' '.join(visible(owner['paneId']).split()))
                    until('owner idle after refusal', lambda: cli('agent', 'get', owner['paneId'])['agent']['agent_status'] in ('idle', 'done'))
                    cli('agent', 'prompt', owner['paneId'], '/continuation-owner decide')
                    until('decision prompt reopened', lambda: 'Submit decision to the existing writer' in visible(owner['paneId']))
                    cli('pane', 'send-keys', owner['paneId'], 'esc')
                    until('owner input interruption recorded', lambda: json.loads(observation_path.read_text()).get('holdReason') == 'interruption')
                    assert json.loads(state_path.read_text())['ownerWaits'][owner['workerId']] == wait
                    assert not (state_dir/f"receipt-{wait['id']}.json").exists()
                    assert decision not in Path(writer_binding['sessionFile']).read_text()
                    print('Native owner decision negatives passed: paused writer and interrupted input retained the wait', flush=True)
                    return
                until('exact decision wait released', lambda: owner['workerId'] not in json.loads(state_path.read_text())['ownerWaits'])
                receipt = json.loads((state_dir/f"receipt-{wait['id']}.json").read_text())
                assert receipt == {'id': wait['id'], 'status': 'sent'}
                until('writer journal contains the decision', lambda: decision in Path(writer_binding['sessionFile']).read_text())
                until('owner command settles', lambda: cli('agent', 'get', owner['paneId'])['agent']['agent_status'] in ('idle', 'done'))
                cli('agent', 'prompt', owner['paneId'], '/continuation-owner decide')
                until('duplicate command refused', lambda:
                      'No fresh pending decision' in ' '.join(visible(owner['paneId']).split()))
                assert Path(writer_binding['sessionFile']).read_text().count(decision) == 1
                print('Native owner decision passed: unrelated input retained wait, one prompt submission and writer receipt, duplicate refused', flush=True)
                return
            if reviewer_recovery:
                preflight, = (json.loads(p.read_text()) for p in state_dir.glob('spawn-????????-????-????-????-????????????.json')
                              if json.loads(p.read_text())['key'] == 'preflight-writer')
                assert preflight['status'] == 'preflight-refused' and not preflight.get('paneRequested') and not preflight.get('child')
                history = {p: p.read_bytes() for p in state_dir.glob('*.json')
                           if p.name.startswith(('spawn-', 'delegation-'))}
                for name in ('smoke-replacement-b', 'smoke-replacement-c'):
                    old = json.loads(state_path.read_text())
                    cli('agent', 'send-keys', supervisor, 'ctrl+d')
                    until('graceful supervisor release', lambda: not (state_dir/'supervisor.lock').exists())
                    supervisor = cli('workspace', 'create', '--label', name, '--cwd', str(work))['root_pane']['pane_id']
                    panes.append(supervisor)
                    until('replacement shell ready', lambda: shell_alone(supervisor))
                    cli('agent', 'start', name, '--kind', 'pi', '--pane', supervisor)
                    cli('agent', 'prompt', supervisor, '/continuation-supervisor start')
                    until('replacement start confirmation', lambda: 'Start continuation supervisor?' in visible(supervisor))
                    cli('agent', 'send-keys', supervisor, 'enter')
                    until('replacement committed', lambda: json.loads(state_path.read_text())['ownerToken'] != old['ownerToken'])
                    until('replacement settled', lambda: cli('agent', 'get', supervisor)['agent']['agent_status'] in ('idle', 'done'))
                    cli('agent', 'prompt', owner['paneId'], '/continuation-delegate recover-reviewers')
                    until('one native reviewer recovery confirmation', lambda: 'Restore read-only reviewer delegation?' in visible(owner['paneId']))
                    cli('agent', 'send-keys', owner['paneId'], 'enter')
                    until('reviewer delegation restored', lambda: any(
                        r['ownerToken'] == json.loads(state_path.read_text())['ownerToken']
                        and r['predecessor'] == {'token': old['ownerToken'], 'sessionId': old['supervisorSession']}
                        for r in (json.loads(p.read_text()) for p in state_dir.glob('reviewer-recovery-*.json'))))
                    until('owner command settled', lambda: cli('agent', 'get', owner['paneId'])['agent']['agent_status'] in ('idle', 'done'))
                cli('agent', 'prompt', owner['paneId'], REVIEW_REQUEST)
                review = until('read-only reviewer dispatched', lambda: dispatched('read-only'), 40)
                panes.append(review['paneId'])
                assert review['authority']['spawnId'] == attempt['id'] and review['grantId'] == attempt['grantId']
                assert review['ownerToken'] == json.loads(state_path.read_text())['ownerToken']
                assert json.loads((state_dir/f"spawn-receipt-{review['id']}.json").read_text())['status'] == 'sent'
                assert 'Read-only delegates cannot create writers' in Path(owner['sessionFile']).read_text()
                attempts = [json.loads(p.read_text()) for p in state_dir.glob('spawn-????????-????-????-????-????????????.json')]
                assert sorted(a['role'] for a in attempts if a['status'] == 'dispatched') == ['owner', 'read-only', 'writer']
                assert len(attempts) == 4
                assert all(p.read_bytes() == content for p, content in history.items())
                print('Native reviewer recovery passed: graceful A/B/C, one confirmation per replacement, one reviewer; '
                      'second writer denied and preflight history unchanged', flush=True)
                return
            assert json.loads(state_path.read_text())['ownerWaits'][owner['workerId']] == {
                'kind': 'child', 'children': [writer_attempt['workerId']]}, settled_owner
            turns = [json.loads(line) for line in Path(owner['sessionFile']).read_text().splitlines()]
            users = [turn for turn in turns if turn.get('message', {}).get('role') == 'user']
            assert len(users) == 1 and model.task in json.dumps(users[0]), users
            grant = json.loads((state_dir/f"delegation-{attempt['grantId']}.json").read_text())
            assert grant['deliveryPreferences']['startReview'] == 'Automatic'
            assert 'Delivery preferences for this assignment:' in json.dumps(users[0])
            assert 'Fix review findings: Ask First' in json.dumps(users[0])
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
    parser.add_argument('--preflight-recovery', action='store_true', help='correct a proved pre-split refusal after reload')
    parser.add_argument('--new-space', action='store_true', help='launch owner and writer in a new isolated Herdr space')
    parser.add_argument('--worktree-choice', action='store_true', help='inspect and cancel the occupied-checkout selector')
    parser.add_argument('--paused-supervisor', action='store_true', help='resume ordinary global pause in owner launch')
    parser.add_argument('--no-supervisor', action='store_true', help='bootstrap a new supervisor in the same invocation')
    parser.add_argument('--restart-supervisor', action='store_true', help='replace a gracefully stopped supervisor from retained state')
    parser.add_argument('--delivery-preferences', action='store_true', help='inspect native delivery menu and cancel')
    parser.add_argument('--reviewer-recovery', action='store_true', help='recover only reviewer delegation in the surviving owner')
    parser.add_argument('--owner-decision', action='store_true', help='submit a single decision in the exact owner pane')
    parser.add_argument('--owner-decision-negative', action='store_true', help='verify native pause and Escape refusal')
    parser.add_argument('--owner-chat', action='store_true', help='clarify, then select one finding via ordinary owner chat')
    parser.add_argument('--planner-queue', action='store_true', help='queue two ordinary-chat backlog entries without interrupting A')
    parser.add_argument('--parallel-assignment', action='store_true', help='launch in an explicitly authorized disposable alternate tree')
    parser.add_argument('--retained-rollover', action='store_true', help='close A explicitly and start queued B in both original sessions')
    parser.add_argument('--automatic-rollover', action='store_true', help='queue B, record A delivery from the owner and observe automatic retained start')
    parser.add_argument('--pi-version', default='1.5.2', help='exact expected Pi version on PATH')
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
                args.nested, args.checkpoint_recovery, args.preflight_recovery, args.new_space,
                args.worktree_choice, args.paused_supervisor, args.no_supervisor, args.restart_supervisor,
                args.delivery_preferences, args.reviewer_recovery, args.owner_decision, args.owner_decision_negative,
                args.owner_chat, args.planner_queue, args.parallel_assignment, args.retained_rollover,
                args.automatic_rollover, args.pi_version)
        finally:
            model.shutdown()
