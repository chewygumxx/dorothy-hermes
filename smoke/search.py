# SPDX-License-Identifier: GPL-3.0-only
"""Exit 1 unless Hermes's session search finds every argument."""

import sys

sys.path.insert(0, "/opt/hermes")

from hermes_state import SessionDB  # noqa: E402

db = SessionDB()
missing = [query for query in sys.argv[1:] if not db.search_messages(query)]
if missing:
    print("missing:", ", ".join(missing))
    sys.exit(1)
print("found:", ", ".join(sys.argv[1:]))
