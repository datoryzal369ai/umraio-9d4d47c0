"""Read-only gateway preflight. Never print credentials or machine configuration."""
import datetime, json, os, subprocess, urllib.request, urllib.error
APP = "umraio-voice-gateway"
BASE = "b5c9f4ebc720a76d05b1d3ccb0dbbc4ec79029fc"
IMAGE = "registry.fly.io/umraio-voice-gateway@sha256:6b7820b5523eb4e78c2027277f793623b9e3993da6716ece96084c4200dc9dad"
MACHINE = "d8925e9b0e5048"
INSTANCE = "01M249086DERB870X8R9XQE9SS"
API = "https://api.machines.dev/v1/apps/" + APP + "/machines"
REPO = "https://api.github.com/repos/datoryzal369ai/umraio-9d4d47c0"
def get(url, credential=None):
    headers={"User-Agent":"umraio-readonly-release-preflight"}
    if credential: headers["Authorization"]="Bearer "+os.environ[credential]
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("HTTP "+str(error.code)+" from "+urllib.parse.urlsplit(url).hostname) from None
def verify():
    current=get(API+"/"+MACHINE,"FLY_API_TOKEN")
    assert current["state"]=="started", "Machine is not started"
    assert current["region"]=="sin", "Unexpected region"
    assert current["instance_id"]==INSTANCE, "Machine changed since baseline deployment"
    assert current["config"]["image"]==IMAGE, "Production image differs"
    machines=get(API,"FLY_API_TOKEN")
    assert [m["id"] for m in machines if m["state"]!="destroyed"]==[MACHINE], "Machine topology differs"
    active=[]
    for page in range(1,10):
        data=get(REPO+"/actions/runs?per_page=100&page="+str(page),"GH_TOKEN")
        for run in data["workflow_runs"]:
            if str(run["id"])!=os.environ["GITHUB_RUN_ID"] and run["status"]!="completed":
                active.append({"id":run["id"],"name":run["name"],"status":run["status"]})
        if len(data["workflow_runs"])<100: break
    assert not active, "Another GitHub workflow is active"
    for endpoint in ("health","ready"):
        health=get("https://"+APP+".fly.dev/"+endpoint)
        assert health.get("status")=="ok" and health.get("build_version")==BASE, "Unexpected "+endpoint+" identity"
        assert health.get("webrtc")=="up" and health.get("speech")=="up", "Readiness unavailable"
        assert health.get("active_sessions")==0, "Active call present"
        print(endpoint.upper()+" PASS: HTTP 200; exact baseline; WebRTC and speech up; zero sessions")
    details=json.loads(subprocess.check_output(["docker","image","inspect",IMAGE],text=True))[0]
    assert IMAGE in details["RepoDigests"], "Rollback digest not retrieved"
    assert "BUILD_VERSION="+BASE in details["Config"]["Env"], "Rollback build differs"
    assert details["Config"]["Labels"]["org.opencontainers.image.revision"]==BASE, "Rollback revision differs"
    print("ROLLBACK RETRIEVABLE: YES",IMAGE)
    print("PRODUCTION SHA:",BASE)
    print("PRODUCTION IMAGE:",IMAGE)
    print("MACHINE INSTANCE:",current["instance_id"])
    print("LAST MACHINE UPDATE:",current.get("updated_at"))
    print("GITHUB DEPLOYMENT IN PROGRESS: NO")
    print("UNEXPECTED MACHINE UPDATE SINCE BASELINE: NO")
    print("PREFLIGHT PASS UTC:",datetime.datetime.now(datetime.timezone.utc).isoformat())
if __name__=="__main__":
    try: verify()
    except Exception as error:
        print("PREFLIGHT FAIL:",type(error).__name__,str(error) if isinstance(error,(AssertionError,RuntimeError)) else "read-only verification unavailable")
        raise SystemExit(1)
