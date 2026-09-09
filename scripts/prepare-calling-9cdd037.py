"""Prepare the exact authorized release; no production mutation in this driver."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys

spec = importlib.util.spec_from_file_location('existing_release', pathlib.Path(__file__).with_name('release-ice-diagnostic-a7f6533.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.SHA = '9cdd037c634fa73ef462073101cab1ccf2d9f33c'
release.BASE = 'a7f653372aaaa5e80e2b9f9c7e6c0b53d380b93c'
FROZEN = '17a1785ced9e36303036c5994fafde42eeff9063'


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


if __name__ == '__main__':
    try:
        {'source': source, 'preflight': preflight, 'image': release.image}[sys.argv[1]]()
    except Exception as error:
        print('STOP:', type(error).__name__, str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'preparation error')
        sys.exit(1)
