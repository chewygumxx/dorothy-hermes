# SPDX-License-Identifier: GPL-3.0-only
"""Print the pinned image's platform allowlist registry as JSON (S6).

Run inside the image:
  docker run --rm --entrypoint /opt/hermes/.venv/bin/python \
    -e HERMES_HOME=/tmp/probe -v "$PWD/scripts:/s:ro" IMAGE /s/platforms.py
"""

import json
import pathlib
import re
import sys

sys.path.insert(0, "/opt/hermes")

from gateway import authz_mixin  # noqa: E402
from gateway.config_env import _ENV_ENABLE_CREDENTIALS  # noqa: E402
from gateway.pairing import _PLATFORM_ALLOWLIST_ENV  # noqa: E402
from gateway.platform_registry import platform_registry  # noqa: E402

platforms = {}
for platform, names in _ENV_ENABLE_CREDENTIALS.items():
    allowed = _PLATFORM_ALLOWLIST_ENV.get(platform.value, "")
    platforms[platform.value] = {
        "enabledBy": sorted(names),
        "allowedUsers": allowed,
        "allowAllUsers": allowed.replace("_ALLOWED_USERS", "_ALLOW_ALL_USERS")
        if allowed
        else "",
    }

extra = (
    set(authz_mixin._ALLOW_BOTS_ENV.values())
    | set(authz_mixin._GROUP_USER_ENV.values())
    | set(authz_mixin._GROUP_CHAT_ENV.values())
)

# Plugin platforms declare their own allowlist and allow-all switches.
for entry in platform_registry.all_entries():
    extra |= {entry.allowed_users_env, entry.allow_all_env} - {""}

# Role allowlists (Discord) grant access before the user allowlist is read.
ROLES = re.compile(r"\b[A-Z][A-Z0-9_]*_ALLOWED_ROLES\b")
for root in ("gateway", "plugins"):
    for source in pathlib.Path("/opt/hermes", root).rglob("*.py"):
        extra |= set(ROLES.findall(source.read_text(errors="replace")))

for entry in platforms.values():
    extra -= {entry["allowedUsers"], entry["allowAllUsers"]}

json.dump(
    {
        "platforms": platforms,
        "globalAllowlist": "GATEWAY_ALLOWED_USERS",
        "globalAllowAll": "GATEWAY_ALLOW_ALL_USERS",
        "extraAllowVariables": sorted(extra),
    },
    sys.stdout,
    indent=4,
    sort_keys=True,
)
sys.stdout.write("\n")
