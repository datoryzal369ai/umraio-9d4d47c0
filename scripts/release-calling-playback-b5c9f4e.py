"""Exact authorized gateway image only; reuse existing lease and rollback driver."""
import datetime
import http.client
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import NamedTuple

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


# Only code-reviewed deployment receipts that independently identify the active
# published Worker belong here. An editor SHA, healthy route, or caller-provided
# "verified" flag is not evidence. No current receipt binds the observed build
# to WORKER, so production fallback is deliberately unavailable.
VERIFIED_WORKER_DEPLOYMENTS = ()
WORKER_ORIGIN = 'https://umraio.com'
WORKER_PROBE_PATH = '/api/public/health/build'
EVIDENCE_MAX_AGE_S = 900


class WorkerDeploymentEvidence(NamedTuple):
    source_kind: str
    record_id: str
    source_url: str
    production_origin: str
    environment: str
    active: bool
    commit_sha: str
    build_time: str
    verified_at: str


class BuildProbeResult(NamedTuple):
    status: object
    headers: dict
    body: bytes
    response_url: str
    transport_error: object = None


class BuildProbeFailure(RuntimeError):
    def __init__(self, category, probe):
        self.category = category
        # Retain the full response for diagnosis without logging arbitrary
        # response bodies, which may contain sensitive error-page content.
        self.probe = probe
        super().__init__('Worker build probe blocked: ' + category)


def read_worker_build_probe():
    url = WORKER_ORIGIN + WORKER_PROBE_PATH + '?gateway_release=' + release.SHA + '&uncached=' + str(time.time_ns())
    request = urllib.request.Request(url, headers={
        'Content-Type': 'application/json',
        'User-Agent': 'umraio-controlled-diagnostic-release',
    }, method='GET')
    try:
        try:
            response = urllib.request.urlopen(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return BuildProbeResult(
                response.code,
                {key.lower(): value for key, value in response.headers.items()},
                response.read(),
                response.geturl(),
            )
    except (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException) as error:
        return BuildProbeResult(None, {}, b'', url, type(error).__name__)


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def _utc_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.timestamp()
    except (ValueError, OverflowError):
        return None


def classify_worker_build_probe(probe):
    if probe.transport_error is not None or probe.status is None:
        raise BuildProbeFailure('application_unavailable', probe)
    parsed_url = urllib.parse.urlsplit(probe.response_url)
    if (parsed_url.scheme + '://' + parsed_url.netloc != WORKER_ORIGIN
            or parsed_url.path != WORKER_PROBE_PATH):
        raise BuildProbeFailure('malformed_or_unexpected_response', probe)
    if probe.status not in (200, 503):
        category = 'application_unavailable' if probe.status >= 500 or probe.status == 429 else 'malformed_or_unexpected_response'
        raise BuildProbeFailure(category, probe)
    if probe.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise BuildProbeFailure('application_unavailable' if probe.status == 503 else 'malformed_or_unexpected_response', probe)
    try:
        payload = json.loads(probe.body, object_pairs_hook=_unique_json_object)
    except (ValueError, UnicodeError):
        raise BuildProbeFailure('malformed_or_unexpected_response', probe) from None
    if not isinstance(payload, dict):
        raise BuildProbeFailure('malformed_or_unexpected_response', probe)
    # An explicitly different full SHA never becomes eligible for fallback,
    # even when the rest of the payload is incomplete or contradictory.
    sha = payload.get('commit_sha')
    if isinstance(sha, str) and re.fullmatch(r'[0-9a-fA-F]{40}', sha) and sha != WORKER:
        raise BuildProbeFailure('explicit_sha_mismatch', probe)
    required = {'ok', 'environment', 'commit_sha', 'commit_short', 'build_time', 'version'}
    if set(payload) != required:
        category = 'application_unavailable' if probe.status == 503 and payload.get('ok') is False and 'error' in payload else 'malformed_or_unexpected_response'
        raise BuildProbeFailure(category, probe)
    if (type(payload['ok']) is not bool or payload['environment'] != 'production'
            or not isinstance(payload['version'], str) or not payload['version']
            or (payload['build_time'] is not None and _utc_timestamp(payload['build_time']) is None)):
        raise BuildProbeFailure('malformed_or_unexpected_response', probe)
    header = probe.headers.get('x-umraio-build')
    if probe.status == 200 and payload['ok'] is True and sha == WORKER and payload['commit_short'] == WORKER[:7]:
        if header is not None and header != WORKER[:7]:
            raise BuildProbeFailure('malformed_or_unexpected_response', probe)
        return 'valid_matching_identity', payload
    if (probe.status == 503 and payload['ok'] is False and sha is None
            and payload['commit_short'] is None and header == 'unknown'
            and _utc_timestamp(payload['build_time']) is not None):
        return 'missing_commit_identity_metadata', payload
    category = ('application_unavailable'
                if probe.status == 503 and sha == WORKER and payload['commit_short'] == WORKER[:7]
                else 'malformed_or_unexpected_response')
    raise BuildProbeFailure(category, probe)


def independently_verified_worker_identity(payload, probe):
    now = time.time()
    for evidence in VERIFIED_WORKER_DEPLOYMENTS:
        # Trust comes from prior independent verification and inclusion in this
        # reviewed registry, never from a field in the endpoint response, an
        # environment variable, or arbitrary supplied JSON.
        if not isinstance(evidence, WorkerDeploymentEvidence):
            continue
        observed_at = _utc_timestamp(evidence.verified_at)
        if (evidence.source_kind not in {
                'lovable_published_deployment', 'authenticated_deployment_metadata',
                'exact_release_source', 'repository_deployment_record'}
                or not evidence.record_id or not evidence.source_url.startswith('https://')
                or evidence.production_origin != WORKER_ORIGIN
                or evidence.environment != 'production' or evidence.active is not True
                or observed_at is None or not 0 <= now - observed_at <= EVIDENCE_MAX_AGE_S
                or evidence.build_time != payload['build_time']):
            continue
        if evidence.commit_sha != WORKER:
            raise BuildProbeFailure('explicit_sha_mismatch', probe)
        return evidence
    raise BuildProbeFailure('missing_commit_identity_metadata_unverified', probe)


def worker():
    probe = read_worker_build_probe()
    classification, payload = classify_worker_build_probe(probe)
    if classification == 'missing_commit_identity_metadata':
        evidence = independently_verified_worker_identity(payload, probe)
        print('WORKER PASS: independently verified active production identity', evidence.commit_sha,
              'source', evidence.source_kind, 'record', evidence.record_id)
        return
    print('WORKER PASS: uncached production identity', payload['commit_sha'])


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



def self_test():
    """Focused offline probe tests, colocated to keep the one-file change limit."""
    import contextlib
    import io
    import unittest
    from email.message import Message
    from unittest import mock

    module = sys.modules[__name__]
    build_time = '2026-09-10T13:10:05.246Z'
    fixed_now = 1789101600.0

    def body(sha=WORKER):
        return {
            'ok': sha is not None, 'environment': 'production',
            'commit_sha': sha, 'commit_short': sha[:7] if sha else None,
            'build_time': build_time, 'version': '0.0.0',
        }

    def probe(status=200, payload=None, raw=None, headers=None):
        if payload is None:
            payload = body(None if status == 503 else WORKER)
        return BuildProbeResult(
            status,
            headers if headers is not None else {
                'content-type': 'application/json; charset=utf-8',
                'x-umraio-build': payload.get('commit_short') or 'unknown',
            },
            json.dumps(payload).encode() if raw is None else raw,
            WORKER_ORIGIN + WORKER_PROBE_PATH,
        )

    # Synthetic reviewed-receipt fixture. Never installed in the production
    # registry or presented as actual Lovable deployment evidence.
    exact_evidence = WorkerDeploymentEvidence(
        'authenticated_deployment_metadata', 'fixture-only-receipt',
        'https://provider.example/fixture-only-deployment',
        WORKER_ORIGIN, 'production', True, WORKER, build_time,
        datetime.datetime.fromtimestamp(fixed_now - 1, datetime.timezone.utc).isoformat(),
    )

    class ProbeTests(unittest.TestCase):
        def invoke(self, result, evidence=()):
            with mock.patch.object(module, 'read_worker_build_probe', return_value=result), \
                    mock.patch.object(module, 'VERIFIED_WORKER_DEPLOYMENTS', evidence), \
                    mock.patch.object(time, 'time', return_value=fixed_now), \
                    contextlib.redirect_stdout(io.StringIO()):
                worker()

        def blocked(self, result, category, evidence=()):
            with self.assertRaises(BuildProbeFailure) as caught:
                self.invoke(result, evidence)
            self.assertEqual(caught.exception.category, category)
            self.assertIs(caught.exception.probe, result)
            self.assertEqual(caught.exception.probe.body, result.body)

        def test_200_matching_sha(self):
            self.invoke(probe())

        def test_200_mismatched_sha_never_uses_fallback(self):
            self.blocked(probe(payload=body('a' * 40)), 'explicit_sha_mismatch', (exact_evidence,))

        def test_exact_recorded_503_is_missing_metadata(self):
            result = probe(503)
            category, parsed = classify_worker_build_probe(result)
            self.assertEqual(category, 'missing_commit_identity_metadata')
            self.assertEqual(parsed, body(None))
            self.blocked(result, 'missing_commit_identity_metadata_unverified')

        def test_exact_independently_reviewed_fallback_fixture(self):
            self.invoke(probe(503), (exact_evidence,))

        def test_production_fallback_has_no_invented_receipts(self):
            self.assertEqual(VERIFIED_WORKER_DEPLOYMENTS, ())

        def test_unreviewed_self_assertion_cannot_authorize_fallback(self):
            alleged = dict(exact_evidence._asdict(), verified=True)
            self.blocked(probe(503), 'missing_commit_identity_metadata_unverified', (alleged,))

        def test_fallback_rejects_wrong_binding_or_stale_receipt(self):
            modifications = [
                {'production_origin': 'https://preview.example'},
                {'environment': 'preview'}, {'active': False},
                {'record_id': ''}, {'source_url': ''},
                {'source_kind': 'latest_editor_commit'},
                {'build_time': '2026-09-07T13:27:52.730Z'},
                {'verified_at': '2026-09-07T13:27:52.730Z'},
                {'verified_at': '2099-01-01T00:00:00Z'},
                {'verified_at': 'unknown'},
            ]
            for changes in modifications:
                with self.subTest(changes=changes):
                    self.blocked(probe(503), 'missing_commit_identity_metadata_unverified',
                                 (exact_evidence._replace(**changes),))

        def test_fallback_exact_sha_mismatch_blocks(self):
            self.blocked(probe(503), 'explicit_sha_mismatch',
                         (exact_evidence._replace(commit_sha='b' * 40),))

        def test_real_availability_failures_block_even_with_fallback(self):
            for status in (429, 500, 502, 504):
                with self.subTest(status=status):
                    self.blocked(probe(status), 'application_unavailable', (exact_evidence,))
            for result in [
                    probe(503, raw=b'<html>Unavailable</html>', headers={'content-type': 'text/html'}),
                    probe(503, payload={'ok': False, 'error': 'Worker not initialized'}),
                    BuildProbeResult(None, {}, b'', WORKER_ORIGIN + WORKER_PROBE_PATH, 'TimeoutError')]:
                with self.subTest(status=result.status, body=result.body):
                    self.blocked(result, 'application_unavailable', (exact_evidence,))

        def test_authentication_error_no_longer_silently_passes(self):
            for status in (401, 403, 404):
                with self.subTest(status=status):
                    self.blocked(probe(status), 'malformed_or_unexpected_response', (exact_evidence,))

        def test_malformed_or_contradictory_body_blocks(self):
            malformed = [
                probe(raw=b'not json'), probe(raw=b''), probe(raw=b'[]'),
                probe(raw=b'null'), probe(raw=b'{"ok":true,"ok":false}'),
                probe(payload=dict(body(), ok='true')),
                probe(payload=dict(body(), environment='preview')),
                probe(payload=dict(body(), commit_short='fffffff')),
                probe(payload=dict(body(), commit_sha=WORKER[:7])),
                probe(payload=dict(body(), verified_fallback=True)),
                probe(payload=dict(body(), build_time='not a date')),
                probe(headers={'content-type': 'text/html'}),
                probe(headers={'content-type': 'application/json', 'x-umraio-build': 'other'}),
                probe(503, headers={'content-type': 'application/json'}),
                probe(503, payload=dict(body(None), commit_short='unknown')),
                probe(503, payload=dict(body(None), build_time=None)),
            ]
            for index, result in enumerate(malformed):
                with self.subTest(case=index):
                    self.blocked(result, 'malformed_or_unexpected_response', (exact_evidence,))

        def test_only_known_503_shape_is_fallback_eligible(self):
            self.blocked(probe(200, payload=body(None)), 'malformed_or_unexpected_response', (exact_evidence,))
            self.blocked(probe(503, payload=body()), 'application_unavailable', (exact_evidence,))
            self.blocked(probe(503, payload=body('c' * 40)), 'explicit_sha_mismatch', (exact_evidence,))

        def test_redirected_response_cannot_prove_production_identity(self):
            for url in ('https://other.example/api/public/health/build', WORKER_ORIGIN + '/login'):
                with self.subTest(url=url):
                    self.blocked(probe()._replace(response_url=url), 'malformed_or_unexpected_response', (exact_evidence,))

        def test_http_error_preserves_full_body_and_headers(self):
            raw = json.dumps(body(None), indent=2).encode() + b' ' * 70000
            headers = Message()
            headers['Content-Type'] = 'application/json'
            headers['X-UMRAIO-Build'] = 'unknown'
            error = urllib.error.HTTPError(
                WORKER_ORIGIN + WORKER_PROBE_PATH, 503, 'Service Unavailable', headers, io.BytesIO(raw))
            with mock.patch.object(urllib.request, 'urlopen', side_effect=error) as opened:
                result = read_worker_build_probe()
            self.assertEqual(result.status, 503)
            self.assertEqual(result.body, raw)
            self.assertEqual(result.headers['x-umraio-build'], 'unknown')
            request = opened.call_args.args[0]
            self.assertEqual(request.get_method(), 'GET')
            self.assertTrue(request.full_url.startswith(WORKER_ORIGIN + WORKER_PROBE_PATH + '?'))
            self.assertEqual(opened.call_args.kwargs, {'timeout': 45})
            self.assertNotIn('Authorization', dict(request.header_items()))
            self.assertEqual(classify_worker_build_probe(result)[0], 'missing_commit_identity_metadata')

        def test_transport_failures_retain_failure_classification(self):
            for error in (urllib.error.URLError('offline'), TimeoutError('timeout'), http.client.IncompleteRead(b'partial')):
                with self.subTest(error=type(error).__name__):
                    with mock.patch.object(urllib.request, 'urlopen', side_effect=error):
                        result = read_worker_build_probe()
                    self.assertIsNone(result.status)
                    self.assertEqual(result.transport_error, type(error).__name__)
                    self.blocked(result, 'application_unavailable', (exact_evidence,))

        def test_failed_probe_prevents_release_helpers(self):
            failure = BuildProbeFailure('missing_commit_identity_metadata_unverified', probe(503))
            for action in (preflight, controlled_release):
                with self.subTest(action=action.__name__):
                    with mock.patch.object(module, 'worker', side_effect=failure), \
                            mock.patch.object(module, 'idle') as idle_call, \
                            mock.patch.object(release, 'preflight') as preflight_call, \
                            mock.patch.object(release, 'release') as release_call:
                        with self.assertRaises(BuildProbeFailure):
                            action()
                        idle_call.assert_not_called()
                        preflight_call.assert_not_called()
                        release_call.assert_not_called()

        def test_post_release_guard_uses_same_blocking_probe(self):
            failure = BuildProbeFailure('explicit_sha_mismatch', probe())
            with mock.patch.object(module, 'original_await_health', return_value={'status': 'ok'}), \
                    mock.patch.object(module, 'worker', side_effect=failure):
                with self.assertRaises(BuildProbeFailure):
                    guarded_await_health(release.SHA)

    class CountingResult(unittest.TextTestResult):
        subtests_run = 0

        def addSubTest(self, test, subtest, error):
            self.subtests_run += 1
            super().addSubTest(test, subtest, error)

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ProbeTests)
    result = unittest.TextTestRunner(verbosity=2, resultclass=CountingResult).run(suite)
    print('FOCUSED RESULT: tests=%d subtests=%d failures=%d errors=%d' %
          (result.testsRun, result.subtests_run, len(result.failures), len(result.errors)))
    print('PRODUCTION FALLBACK EVIDENCE: unavailable; acceptance tests use synthetic receipts only.')
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['self-test']:
        sys.exit(self_test())
    try:
        {'source': source, 'preflight': preflight, 'rollback-image': rollback_image, 'image': release.image, 'release': controlled_release}[sys.argv[1]]()
    except Exception as error:
        print('STOP:', type(error).__name__, str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'release driver error')
        sys.exit(1)
