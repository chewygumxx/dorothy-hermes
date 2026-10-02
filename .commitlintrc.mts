// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/.commitlintrc.mts
//
//

import { defineConfig } from "@chewygumxx/commitlint-config";

// Types, limits and the prompt are shared; only the scopes are this
// repository's own.
export default defineConfig({
    scopes: [
        {
            name: "claude",
            fullName: "Claude",
            description: "Claude Code assets ie. hooks, skills, agents, etc.",
        },
    ],
});
