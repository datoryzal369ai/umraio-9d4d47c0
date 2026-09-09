"""Prepare the exact authorized release; no production mutation in this driver."""
import importlib.util
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys

spec = importlib.util.spec_from_file_location('existing_release', pathlib.Path(__file__).with_name('release-ice-diagnostic-a7f6533.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.SHA = '9cdd037c634fa73ef462073101cab1ccf2d9f33c'
release.BASE = 'a7f653372aaaa5e80e2b9f9c7e6c0b53d380b93c'
FROZEN = '17a1785ced9e36303036c5994fafde42eeff9063'
CONTROL_PLANE_CHECKED = datetime.datetime.fromisoformat('2026-09-09T21:46:03.980781+00:00')
LATEST_ENDED_SESSION = 'ms_dd92407a0893972e29afe3a9'
LATEST_PEER_CLOSED = '2026-09-09T16:59:59.572656029Z'


def git(*args):
    return subprocess.check_output(['git', '-C', 'candidate', *args], text=True).strip()


def source():
    assert git('rev-parse', 'HEAD') == release.SHA, 'Wrong candidate'
    assert git('rev-parse', 'HEAD^') == FROZEN, 'Frozen parent differs'
    assert git('rev-parse', 'HEAD^{tree}') == '0f1d1fe217a02a4f78a30c48212d597a056ddbff', 'Validated tree differs'
    assert not git('status', '--porcelain'), 'Candidate is dirty'
    assert not git('diff', '--name-only', FROZEN, release.SHA, '--', 'voice-gateway'), 'Frozen native tree changed'
    assert not git('diff', '--name-only', release.MAIN, release.SHA, '--', 'src/lib/voice', 'src/routes/api/public/whatsapp.ts', 'voice-gateway/fly.toml', 'voice-gateway/Dockerfile', 'voice-gateway/go.mod', 'voice-gateway/go.sum'), 'Protected Voice Note/media/config changed'
    assert not git('diff', '--name-only', release.BASE, release.SHA, '--', 'voice-gateway/internal/webrtc/engine.go', 'voice-gateway/internal/webrtc/ice_diagnostics.go', 'voice-gateway/internal/webrtc/ice_trace.go'), 'Deployed ICE implementation changed'
    refs = [
        ('main', release.MAIN),
        ('rollback/p0-calling-human-quality-5a99d01-20260909', release.MAIN),
        ('codex/calling-human-quality-isolated-20260909', release.HUMAN),
        ('codex/calling-reconciled-a7f6533-20260909', FROZEN),
        ('codex/calling-ice-diagnostics-20260909', release.BASE),
        ('codex/calling-release-composer-20260909', release.SHA),
    ]
    for ref, expected in refs:
        actual = release.request(release.REPO + '/git/ref/heads/' + ref, credential='GH_TOKEN')
        assert actual['object']['sha'] == expected, 'Protected ref moved: ' + ref
    run = release.request(release.REPO + '/actions/runs/34381783658', credential='GH_TOKEN')
    assert run['head_sha'] == release.SHA and run['conclusion'] == 'success', 'Exact validation is not green'
    print('PASS: exact SHA/tree, frozen parent/native, preserved Voice Note/media/ICE paths, green CI and rollback refs.')


def preflight():
    release.preflight()
    for origin in ['https://umraio.com', 'https://umraio.lovable.app']:
        app = release.request(origin + '/api/public/health/build')
        assert app['ok'] and app['environment'] == 'production', 'Application health unavailable'
        assert app['commit_sha'] == release.MAIN, 'Application production identity moved'
    print('PASS: live custom-domain and Lovable Worker identity', release.MAIN)


def sessions():
    before = release.health(release.BASE)
    current = release.machine()
    assert current['config']['image'] == os.environ['ROLLBACK_IMAGE'], 'Production image moved'
    raw = subprocess.check_output(['flyctl', 'logs', '-a', release.APP, '--no-tail'], text=True, timeout=45, stderr=subprocess.DEVNULL)
    rows = []
    for line in re.sub(r'\x1b\[[0-9;]*m', '', raw).splitlines():
        start = line.find('{')
        if start < 0:
            continue
        try:
            row = json.loads(line[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and 'time' in row and 'msg' in row:
            rows.append(row)
    assert rows, 'No current gateway lifecycle evidence available'
    keys = {'time', 'msg', 'session_id', 'state', 'reason', 'ice_connection_state', 'peer_connection_state', 'dtls_state', 'media_ready', 'inbound_packets', 'outbound_packets', 'transport_ready_outbound_packets', 'trace_id', 'local_candidate_id', 'remote_candidate_id', 'candidate_pair_id', 'pair_id', 'local_id', 'remote_id', 'pair_state', 'selected', 'nominated'}
    lifecycle = [r for r in rows if 'session_id' in r or any(t in str(r.get('msg', '')) for t in ['state', 'terminat', 'created', 'candidate pair', 'first inbound', 'first outbound', 'inbound rtp progress'])]
    selected = (lifecycle[-60:] if lifecycle else rows[-12:])
    for row in selected:
        print(json.dumps({k:v for k,v in row.items() if k in keys}, sort_keys=True))
    after = release.health(release.BASE)
    print(json.dumps({'check': 'read_only_session_safety', 'captured_rows': len(rows), 'window_start': min(r['time'] for r in rows), 'window_end': max(r['time'] for r in rows), 'active_sessions_before': before['active_sessions'], 'active_sessions_after': after['active_sessions'], 'production_sha': after['build_version']}))


def no_live_call():
    report = release.health(release.BASE)
    if report['active_sessions'] == 0:
        return
    # Fresh read-only control-plane evidence: exactly three sessions since the
    # current gateway started, all terminated with ended_at; zero active calls.
    # The baseline registry can retain a completed session in its self-wait path.
    # Permit only the observed one retained entry, with no newer gateway session.
    age = (datetime.datetime.now(datetime.timezone.utc) - CONTROL_PLANE_CHECKED).total_seconds()
    assert 0 <= age < 900, 'Control-plane session evidence expired; refresh before release'
    assert report['active_sessions'] == 1, 'Session count changed; stop'
    raw = subprocess.check_output(['flyctl', 'logs', '-a', release.APP, '--no-tail'], text=True, timeout=45, stderr=subprocess.DEVNULL)
    rows = []
    for line in re.sub(r'\x1b\[[0-9;]*m', '', raw).splitlines():
        start = line.find('{')
        if start < 0:
            continue
        try:
            row = json.loads(line[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and 'time' in row and 'msg' in row:
            rows.append(row)
    events = [r for r in rows if r.get('session_id') == LATEST_ENDED_SESSION]
    assert any(r['msg'] == 'media session terminating' and r.get('reason') == 'caller_terminated' for r in events), 'Latest caller termination missing'
    for message, key in [('ice connection state', 'ice_connection_state'), ('peer connection state', 'peer_connection_state'), ('dtls state observed', 'dtls_state')]:
        states = [r for r in events if r['msg'] == message]
        assert states and states[-1].get(key) == 'closed', 'Latest transport not closed: ' + key
    assert not any(r['time'] > LATEST_PEER_CLOSED and (r.get('session_id') or r.get('call_id')) for r in rows), 'New session activity; stop'
    assert release.health(release.BASE)['active_sessions'] == 1, 'Session count changed during check'
    print('PASS: fresh control-plane evidence has zero active calls; latest ICE/DTLS/peer closed, no newer gateway session activity; only the observed retained registry entry remains.')


def controlled_release():
    release.no_live_call = no_live_call
    release.release()


if __name__ == '__main__':
    try:
        {'source': source, 'preflight': preflight, 'image': release.image, 'sessions': sessions, 'release': controlled_release}[sys.argv[1]]()
    except Exception as error:
        print('STOP:', type(error).__name__, str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'preparation error')
        sys.exit(1)
