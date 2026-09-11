"""Reuse an existing exact candidate image; package it once only if absent."""
import os, subprocess, sys
image=os.environ["CANDIDATE_IMAGE"]
candidate=os.environ["CANDIDATE"]
result=subprocess.run(["docker","manifest","inspect",image],capture_output=True,text=True,timeout=60)
if result.returncode==0:
    print("EXISTING CANDIDATE IMAGE FOUND: reusing without rebuild",flush=True)
    subprocess.run(["docker","pull",image],check=True)
elif "manifest unknown" in result.stderr.lower() or "no such manifest" in result.stderr.lower():
    print("CANDIDATE IMAGE ABSENT: initial packaging of exact validated SHA",flush=True)
    subprocess.run(["docker","build","--network","host","--build-arg","BUILD_VERSION="+candidate,
                    "--label","org.opencontainers.image.revision="+candidate,
                    "--tag",image,"candidate/voice-gateway"],check=True)
    subprocess.run(["docker","push",image],check=True)
else:
    print("STOP: candidate registry lookup failed; no build or deployment",flush=True)
    sys.exit(1)
subprocess.run(["python3","release-driver/scripts/release-calling-playback-b5c9f4e.py","image"],check=True)
