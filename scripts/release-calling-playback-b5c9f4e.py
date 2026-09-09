"""Exact authorized gateway image only; reuse existing lease and rollback driver."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('existing_release', pathlib.Path(__file__).with_name('release-ice-diagnostic-a7f6533.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.SHA = 'b5c9f4ebc720a76d05b1d3ccb0dbbc4ec79029fc'
release.BASE = '9cdd037c634fa73ef462073101cab1ccf2d9f33c'


def git(*args):
    return subprocess.check_output(['git', '-C', 'candidate', *args], text=True).strip()


def source():
    assert git('rev-parse', 'HEAD') == release.SHA, 'Wrong candidate'
    assert git('rev-parse', 'HEAD^') == release.BASE, 'Wrong parent'
    assert git('rev-parse', 'HEAD^{tree}') == '7e9d783365ff9d43873500f4e06e72d42d87accd', 'Validated tree differs'
    assert not git('status', '--porcelain'), 'Candidate source is dirty'
    allowed = {
        '.github/workflows/calling-playback-lifecycle-candidate.yml',
        'voice-gateway/internal/media/conversation.go',
        'voice-gateway/internal/media/playback_lifecycle_test.go',
        'voice-gateway/internal/tts/minimax.go',
        'voice-gateway/internal/tts/speaker.go',
        'voice-gateway/internal/tts/cancellation_test.go',
    }
    assert set(git('diff', '--name-only', release.BASE, release.SHA).splitlines()) == allowed, 'Unexpected source changes'
    for ref, expected in [
        ('codex/calling-playback-lifecycle-20260910', release.SHA),
        ('codex/calling-release-composer-20260909', release.BASE),
    ]:
        actual = release.request(release.REPO + '/git/ref/heads/' + ref, credential='GH_TOKEN')
        assert actual['object']['sha'] == expected, 'Protected release ref moved: ' + ref
    run = release.request(release.REPO + '/actions/runs/34416965871', credential='GH_TOKEN')
    assert run['head_sha'] == release.SHA and run['status'] == 'completed' and run['conclusion'] == 'success', 'Exact candidate validation is not green'
    print('SOURCE PASS: exact SHA/parent/tree, six validated files only, existing green CI. Worker/Voice Note/codec/WebRTC/ICE/config paths unchanged.')


def worker():
    app = release.request('https://umraio.com/api/public/health/build?gateway_release=' + release.SHA + '&uncached=' + str(time.time_ns()))
    assert app.get('ok') and app.get('environment') == 'production', 'Worker health unavailable'
    assert app.get('commit_sha') == release.BASE, 'Worker production identity differs from authorized state'
    print('WORKER PASS: uncached production identity', app['commit_sha'])


def idle():
    report = release.health(release.BASE, require_idle=True)
    print('SESSION SAFETY PASS: active_sessions', report['active_sessions'])


def preflight():
    worker()
    idle()
    release.preflight()


def rollback_image():
    details = json.loads(subprocess.check_output(['docker', 'image', 'inspect', os.environ['ROLLBACK_IMAGE']], text=True))[0]
    assert os.environ['ROLLBACK_IMAGE'] in details['RepoDigests'], 'Rollback digest unavailable'
    assert 'BUILD_VERSION=' + release.BASE in details['Config']['Env'], 'Rollback version differs'
    assert details['Config']['Labels']['org.opencontainers.image.revision'] == release.BASE, 'Rollback revision differs'
    print('ROLLBACK PASS: immutable previous production image retrieved and exact version verified.')


original_await_health = release.await_health
original_request = release.request


def guarded_await_health(version):
    report = original_await_health(version)
    # Runs inside the existing automatic rollback boundary after the new image
    # becomes ready. Rollback itself must remain independent of Worker health.
    if version == release.SHA:
        worker()
    return report


def release_request(url, method='GET', body=None, credential=None, nonce=None):
    if method == 'POST' and url.endswith('/lease'):
        body = dict(body, description='Authorized playback b5c9f4e image-only release')
    return original_request(url, method, body, credential, nonce)


def controlled_release():
    worker()
    release.no_live_call = idle
    release.await_health = guarded_await_health
    release.request = release_request
    release.release()


if __name__ == '__main__':
    try:
        {'source': source, 'preflight': preflight, 'rollback-image': rollback_image, 'image': release.image, 'release': controlled_release}[sys.argv[1]]()
    except Exception as error:
        print('STOP:', type(error).__name__, str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'release driver error')
        sys.exit(1)
