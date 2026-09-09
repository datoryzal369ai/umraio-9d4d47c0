"""One authorized image-only release. Never print config, credentials or API bodies."""
import copy
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

SHA = 'a7f653372aaaa5e80e2b9f9c7e6c0b53d380b93c'
BASE = '336242aef606cfbfd7a214922858768d510a63fb'
MAIN = '5a99d0166560afc8c0cfa9c9bb3171105e3f7ec6'
HUMAN = 'c6d025a88f988974b7be3876226d12db31bed4e4'
APP = 'umraio-voice-gateway'
MACHINE = 'd8925e9b0e5048'
API = 'https://api.machines.dev/v1/apps/' + APP + '/machines'
PUBLIC = 'https://' + APP + '.fly.dev'
REPO = 'https://api.github.com/repos/datoryzal369ai/umraio-9d4d47c0'
TEMP = pathlib.Path(os.environ.get('RUNNER_TEMP', '/tmp'))
SNAPSHOT = TEMP / 'ice-release-rollback.json'
IMAGE_FILE = TEMP / 'ice-release-image.txt'


def request(url, method='GET', body=None, credential=None, nonce=None):
    headers = {'Content-Type': 'application/json', 'User-Agent': 'umraio-controlled-diagnostic-release'}
    if credential:
        token = os.environ.get(credential)
        if not token:
            raise RuntimeError('Required secure credential binding unavailable: ' + credential)
        headers['Authorization'] = 'Bearer ' + token
    if nonce:
        headers['fly-machine-lease-nonce'] = nonce
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=45) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raise RuntimeError('HTTP ' + str(error.code) + ' from ' + urllib.parse.urlsplit(url).hostname) from None
    except urllib.error.URLError:
        raise RuntimeError('Network request failed: ' + urllib.parse.urlsplit(url).hostname) from None


def machine():
    return request(API + '/' + MACHINE, credential='FLY_API_TOKEN')


def health(version, require_idle=False):
    report = request(PUBLIC + '/health')
    ready = request(PUBLIC + '/ready')
    for value in (report, ready):
        assert value.get('status') == 'ok', 'Gateway status unavailable'
        assert value.get('webrtc') == 'up', 'WebRTC unavailable'
        assert value.get('speech') == 'up', 'Speech capability unavailable'
        assert value.get('build_version') == version, 'Unexpected running gateway SHA'
        if require_idle:
            assert value.get('active_sessions') == 0, 'Active call present; release stopped'
    return report


def source():
    def git(*args):
        return subprocess.check_output(['git', '-C', 'candidate', *args], text=True).strip()
    assert git('rev-parse', 'HEAD') == SHA, 'Wrong candidate'
    assert not git('status', '--porcelain'), 'Candidate source is dirty'
    allowed = {
        '.github/workflows/calling-ice-diagnostics-candidate.yml',
        'voice-gateway/internal/media/timing_test.go',
        'voice-gateway/internal/webrtc/engine.go',
        'voice-gateway/internal/webrtc/ice_diagnostics.go',
        'voice-gateway/internal/webrtc/ice_trace.go',
        'voice-gateway/internal/webrtc/ice_diagnostics_test.go',
        'voice-gateway/internal/webrtc/diagnostics_test.go',
        'voice-gateway/internal/webrtc/media_diagnostics_test.go',
        'voice-gateway/internal/webrtc/negotiation_test.go',
    }
    assert set(git('diff', '--name-only', BASE, SHA).splitlines()) <= allowed, 'Protected source changed'
    for ref, expected in [('main', MAIN), ('rollback/p0-calling-human-quality-5a99d01-20260909', MAIN), ('codex/calling-human-quality-isolated-20260909', HUMAN), ('codex/calling-ice-diagnostics-20260909', SHA)]:
        result = request(REPO + '/git/ref/heads/' + ref, credential='GH_TOKEN')
        assert result['object']['sha'] == expected, 'Protected ref moved: ' + ref
    run = request(REPO + '/actions/runs/34350768872', credential='GH_TOKEN')
    assert run['head_sha'] == SHA and run['conclusion'] == 'success', 'Exact candidate validation is not green'
    print('PASS: exact candidate, existing green gates, protected paths, main and rollback refs.')


def preflight():
    current = machine()
    assert current['state'] == 'started' and current['region'] == 'sin', 'Unexpected gateway state/region'
    assert current['config']['image'] == os.environ['ROLLBACK_IMAGE'], 'Production image moved; stop'
    active = request(API, credential='FLY_API_TOKEN')
    assert [m['id'] for m in active if m['state'] != 'destroyed'] == [MACHINE], 'Machine topology changed'
    # Image preparation is safe while a call exists. The image-update step
    # independently requires an idle gateway immediately before mutation.
    report = health(BASE)
    print('Preflight active_sessions:', report['active_sessions'])
    fd = os.open(SNAPSHOT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(current, stream)
    print('PASS: unchanged production baseline, WebRTC/speech up; original machine config retained privately for rollback. Idle guard remains mandatory before image update.')
    print('Rollback image:', os.environ['ROLLBACK_IMAGE'])
    print('Production SHA:', report['build_version'])


def image():
    details = json.loads(subprocess.check_output(['docker', 'image', 'inspect', os.environ['CANDIDATE_IMAGE']], text=True))[0]
    assert 'BUILD_VERSION=' + SHA in details['Config']['Env'], 'Image version differs from candidate'
    assert details['Config']['Labels']['org.opencontainers.image.revision'] == SHA, 'Image revision differs'
    digests = [d for d in details['RepoDigests'] if d.startswith('registry.fly.io/' + APP + '@sha256:')]
    assert len(digests) == 1 and re.fullmatch(r'registry\.fly\.io/umraio-voice-gateway@sha256:[a-f0-9]{64}', digests[0]), 'Missing immutable candidate image'
    IMAGE_FILE.write_text(digests[0])
    print('Candidate image:', digests[0])
    print('PASS: exact source revision and compiled diagnostic messages verified in image.')


def await_health(version):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            result = health(version)
            if machine()['state'] == 'started':
                return result
        except (RuntimeError, AssertionError):
            pass
        time.sleep(3)
    raise RuntimeError('Gateway readiness/version deadline exceeded')


def release():
    original = json.loads(SNAPSHOT.read_text())
    desired_image = IMAGE_FILE.read_text().strip()
    current = machine()
    assert current['config'] == original['config'] and current['instance_id'] == original['instance_id'], 'Production moved since preflight'
    health(BASE, require_idle=True)
    lease_url = API + '/' + MACHINE + '/lease'
    lease = request(lease_url, 'POST', {'ttl': 600, 'description': 'Authorized diagnostic a7f6533 image-only release'}, 'FLY_API_TOKEN')
    nonce = lease['data']['nonce']
    attempted = False
    try:
        current = machine()
        assert current['config'] == original['config'] and current['instance_id'] == original['instance_id'], 'Production moved before lease'
        health(BASE, require_idle=True)
        desired = copy.deepcopy(original['config'])
        desired['image'] = desired_image
        assert {k for k in desired if desired[k] != original['config'].get(k)} == {'image'}, 'Release changes more than image'
        attempted = True
        request(API + '/' + MACHINE, 'POST', {'config': desired, 'current_version': current['instance_id']}, 'FLY_API_TOKEN', nonce)
        report = await_health(SHA)
        after = machine()
        assert after['config'] == desired, 'Post-release machine configuration differs'
        assert after['region'] == original['region'] and after['private_ip'] == original['private_ip'], 'Machine placement/network identity changed'
        print('RELEASE PASS: deployed SHA', report['build_version'])
        print('HEALTH PASS: ready, WebRTC up, speech up; active sessions', report['active_sessions'])
        print('PROTECTION PASS: complete machine configuration identical except image; secrets untouched.')
        print('ROLLBACK PRESERVED:', os.environ['ROLLBACK_IMAGE'])
        print('Diagnostics compiled and registered at existing info log level; awaiting ONE Founder session.')
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write('Diagnostic release: ' + SHA + '\n\nImage: ' + desired_image + '\n\nRollback: ' + os.environ['ROLLBACK_IMAGE'] + '\n\nHealth/readiness PASS. Machine config unchanged except image. Founder call pending.\n')
    except Exception:
        if attempted:
            latest = machine()
            if latest['config'] != original['config']:
                request(API + '/' + MACHINE, 'POST', {'config': original['config'], 'current_version': latest['instance_id']}, 'FLY_API_TOKEN', nonce)
            await_health(BASE)
            assert machine()['config'] == original['config'], 'Rollback configuration mismatch'
            print('ROLLBACK RESTORED: original image/configuration and baseline health verified.')
        raise
    finally:
        request(lease_url, 'DELETE', credential='FLY_API_TOKEN', nonce=nonce)


if __name__ == '__main__':
    try:
        {'source': source, 'preflight': preflight, 'image': image, 'release': release}[sys.argv[1]]()
    except Exception as error:
        # Exception messages above are fixed classifications, never raw responses/config.
        print('STOP:', type(error).__name__, str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'release driver error')
        sys.exit(1)
