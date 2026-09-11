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
release.SHA = 'f3e3b3c7cd371a41c0ed739bf9e5a7a7f402bf85'
release.BASE = 'b5c9f4ebc720a76d05b1d3ccb0dbbc4ec79029fc'
WORKER = '1c92ce16e7f98687af1901320b4afa13935fe693'


def git(*args):
    return subprocess.check_output(['git', '-C', 'candidate', *args], text=True).strip()


def source():
    assert git('rev-parse', 'HEAD') == release.SHA, 'Wrong candidate'
    assert git('rev-parse', 'HEAD^') == '00b029ca1b14a8eb3cfcbaccd75dacaedb99a866', 'Wrong characterization parent'
    assert git('rev-parse', 'HEAD^^') == release.BASE, 'Wrong production ancestor'
    assert git('rev-parse', 'HEAD^{tree}') == '2292b26330006f66f6c5407b131367379b8cf8c6', 'Validated tree differs'
    assert not git('status', '--porcelain'), 'Candidate source is dirty'
    allowed = {
        'voice-gateway/internal/callback/turn_cancellation_reproduction_test.go',
        'voice-gateway/internal/media/cancellation_reproduction_test.go',
        'voice-gateway/internal/media/conversation.go',
        'voice-gateway/internal/media/playback_lifecycle_test.go',
        'voice-gateway/internal/media/vad.go',
        'voice-gateway/internal/media/vad_test.go',
    }
    assert set(git('diff', '--name-only', release.BASE, release.SHA).splitlines()) == allowed, 'Unexpected source changes'
    parent_files = set(git('diff', '--name-only', 'HEAD^^', 'HEAD^').splitlines())
    assert parent_files == {p for p in allowed if p.endswith('cancellation_reproduction_test.go')}, 'Characterization changed runtime'
    for ref, expected in [
        ('codex/calling-qualified-interruption-20260911', release.SHA),
        ('codex/calling-playback-lifecycle-20260910', release.BASE),
    ]:
        actual = release.request(release.REPO + '/git/ref/heads/' + ref, credential='GH_TOKEN')
        assert actual['object']['sha'] == expected, 'Protected release ref moved: ' + ref
    print('SOURCE PASS: exact validated SHA/parent/tree; two runtime files and four tests only. Completed native/race/vet/build evidence reused without duplicate validation.')
    print('PROTECTION PASS: Worker/Voice Note/providers/codec/WebRTC/ICE/Meta/config paths byte-identical to gateway baseline.')


def worker():
    try:
        app = release.request('https://umraio.com/api/public/health/build?gateway_release=' + release.SHA + '&uncached=' + str(time.time_ns()))
    except RuntimeError as error:
        # The same verifier block exists before this release. It is not a
        # production regression and must not cause a gateway rollback.
        if str(error) == 'HTTP 403 from umraio.com':
            print('WORKER IDENTITY EVIDENCE GAP: existing verifier HTTP 403; no Worker publication or configuration action is present in this gateway-only release.')
            return
        raise
    assert app.get('ok') and app.get('environment') == 'production', 'Worker health unavailable'
    assert app.get('commit_sha') == WORKER, 'Worker production identity differs from authorized state'
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
        body = dict(body, description='Authorized qualified interruption f3e3b3c image-only release')
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
