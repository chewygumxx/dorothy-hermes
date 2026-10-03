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
// repository's own. They follow the trust split: what runs in the hermes
// container, what runs in the trusted sidecar, and the stack that joins
// them. A scope is optional; an empty list would allow any.
export default defineConfig({
    scopes: [
        {
            name: "hermes",
            fullName: "Hermes container",
            description: "Bootstrap, config apply, snapshots and s6 stubs",
        },
        {
            name: "sidecar",
            fullName: "Sidecar",
            description: "dorothy-init and dorothy-sync, the trusted side",
        },
        {
            name: "compose",
            fullName: "Compose stack",
            description: "compose.yaml: services, networks, volumes",
        },
        {
            name: "smoke",
            fullName: "Smoke test",
            description: "smoke/ and its CI job",
        },
        {
            name: "scripts",
            fullName: "Scripts",
            description: "scripts/: generators and lint helpers",
        },
        {
            name: "specs",
            fullName: "Specs and plans",
            description: "docs/specs/ and docs/plans/",
        },
    ],
});
