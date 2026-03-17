import os
import sys
import json
import base64
import subprocess
import tempfile

language = os.environ.get("LANGUAGE", "python").lower()
code_b64 = os.environ.get("CODE_B64", "")
timeout_seconds = int(os.environ.get("TIMEOUT_SECONDS", "25"))

try:
    code = base64.b64decode(code_b64).decode("utf-8")
except Exception as e:
    print(json.dumps({"stdout": "", "stderr": f"Failed to decode code: {e}", "exitCode": 1}))
    sys.exit(0)

if language == "python":
    suffix = ".py"
    cmd_prefix = ["python"]
elif language == "javascript":
    suffix = ".js"
    cmd_prefix = ["node"]
else:
    print(json.dumps({"stdout": "", "stderr": f"Unsupported language: {language}. Supported: python, javascript", "exitCode": 1}))
    sys.exit(0)

try:
    with tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False, dir="/tmp") as f:
        f.write(code)
        fname = f.name

    result = subprocess.run(
        cmd_prefix + [fname],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )

    print(json.dumps({
        "stdout": result.stdout[:10000],
        "stderr": result.stderr[:5000],
        "exitCode": result.returncode,
    }))
except subprocess.TimeoutExpired:
    print(json.dumps({"stdout": "", "stderr": f"Execution timed out after {timeout_seconds} seconds", "exitCode": 124}))
except Exception as e:
    print(json.dumps({"stdout": "", "stderr": str(e), "exitCode": 1}))
